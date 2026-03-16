import { z } from "zod";
import type { LlmUsage, LlmUsageTotals, PolicyMode, RunOutcome, ToolCallRecord } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import { applyToolAllowlist, discoverLeadAgentTools } from "../agent/tools/registry.js";
import type { AgentSynthesisState, LeadAgentDefaults, LeadAgentState, LeadAgentToolContext } from "../agent/types.js";
import { parseRequestedLeadCount } from "../tools/lead/requestIntent.js";
import { runOpenAiStructuredChatWithDiagnostics } from "../services/openAiClient.js";
import { LlmBudgetManager } from "../tools/lead/llmBudget.js";
import type { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import type { LeadExecutionBrief } from "../tools/lead/schemas.js";
import type { AgentTaskContract } from "../agent/skills/types.js";
import { writeLeadsCsv } from "../tools/csv/writeCsv.js";
import { redactValue } from "../utils/redact.js";
import { composeSystemPrompt } from "../prompts/composePrompt.js";
import { ALFRED_MASTER_PROMPT_VERSION, ALFRED_MASTER_SYSTEM_PROMPT } from "../prompts/master/alfred.system.js";
import { LEAD_DOMAIN_PROMPT_VERSION, LEAD_GENERATION_DOMAIN_SYSTEM_PROMPT } from "../prompts/domains/leadGeneration.system.js";
import { LEAD_PLANNER_ROLE_PROMPT_VERSION, LEAD_PLANNER_ROLE_SYSTEM_PROMPT } from "../prompts/roles/planner.system.js";

export type AgentStopReason =
  | "target_met"
  | "budget_exhausted"
  | "diminishing_returns"
  | "tool_blocked"
  | "manual_guardrail"
  | "manual_cancelled";

export type BudgetMode = "normal" | "conserve" | "emergency";

interface LeadAgentObservation {
  iteration: number;
  actionType: "single" | "parallel";
  toolNames: string[];
  budgetMode?: BudgetMode;
  expectedLlmCap?: number;
  yieldRelevant: boolean;
  llmTokensUsed: number;
  newLeadCount: number;
  totalLeadCount: number;
  failedToolCount: number;
  searchFailureCount: number;
  browseFailureCount: number;
  extractionFailureCount: number;
  semanticMissCount?: number;
  retrievalBlockedCount?: number;
  failureCodes?: string[];
  leadPipelineInputSummaries?: string[];
  hadLlmBudgetExhausted: boolean;
  note: string;
}

interface BudgetSnapshot {
  mode: BudgetMode;
  remainingMs: number;
  elapsedMs: number;
  remainingTimeRatio: number;
  toolCallsRemaining: number;
  toolCallRatio: number;
  plannerCallsRemaining: number;
  plannerCallRatio: number;
  llmCallsRemaining: number;
  llmCallRatio: number;
}

interface YieldSignal {
  status: "ok" | "low" | "insufficient";
  averageLeadsPer1kTokens: number;
  sampleCount: number;
  threshold: number;
}

interface DeficitStrategy {
  deficit: number;
  threshold: number;
  recommendation: "growth" | "polish_only";
  emailRequested: boolean;
}

interface AtomicNextActionHint {
  tool: "lead_search_shortlist" | "web_fetch" | "lead_extract" | "email_enrich" | "write_csv" | "lead_pipeline";
  input: Record<string, unknown>;
  rationale: string;
}

interface SingleAction {
  type: "single";
  tool: string;
  input: Record<string, unknown>;
}

interface ParallelAction {
  type: "parallel";
  tools: Array<{
    tool: string;
    input: Record<string, unknown>;
  }>;
}

type AgentAction = SingleAction | ParallelAction;

interface PlannerOutput {
  thought: string;
  actionType: "single" | "parallel" | "stop";
  singleAction: {
    tool: string;
    inputJson: string;
  } | null;
  parallelActions: Array<{
    tool: string;
    inputJson: string;
  }> | null;
  stopReason: AgentStopReason | null;
  stopExplanation: string | null;
}

const PlannerOutputSchema: z.ZodType<PlannerOutput> = z.object({
  thought: z.string().min(1).max(500),
  actionType: z.enum(["single", "parallel", "stop"]),
  singleAction: z
    .object({
      tool: z.string().min(1).max(80),
      inputJson: z.string().min(2).max(1200)
    })
    .nullable(),
  parallelActions: z
    .array(
      z.object({
        tool: z.string().min(1).max(80),
        inputJson: z.string().min(2).max(1200)
      })
    )
    .max(4)
    .nullable(),
  stopReason: z.enum(["target_met", "budget_exhausted", "diminishing_returns", "tool_blocked", "manual_guardrail", "manual_cancelled"]).nullable(),
  stopExplanation: z.string().max(320).nullable()
});

const PLANNER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    actionType: { type: "string", enum: ["single", "parallel", "stop"] },
    singleAction: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            tool: { type: "string", minLength: 1, maxLength: 80 },
            inputJson: { type: "string", minLength: 2, maxLength: 1200 }
          },
          required: ["tool", "inputJson"]
        },
        { type: "null" }
      ]
    },
    parallelActions: {
      anyOf: [
        {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              tool: { type: "string", minLength: 1, maxLength: 80 },
              inputJson: { type: "string", minLength: 2, maxLength: 1200 }
            },
            required: ["tool", "inputJson"]
          }
        },
        { type: "null" }
      ]
    },
    stopReason: {
      anyOf: [
        {
          type: "string",
          enum: ["target_met", "budget_exhausted", "diminishing_returns", "tool_blocked", "manual_guardrail", "manual_cancelled"]
        },
        { type: "null" }
      ]
    },
    stopExplanation: {
      anyOf: [{ type: "string", maxLength: 320 }, { type: "null" }]
    }
  },
  required: ["thought", "actionType", "singleAction", "parallelActions", "stopReason", "stopExplanation"]
} as const;

export interface LeadAgentRuntimeOptions {
  parentRunId?: string;
  delegationId?: string;
  scratchpad?: Record<string, unknown>;
  leadExecutionBrief?: LeadExecutionBrief;
  taskContract?: AgentTaskContract;
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  message: string;
  runId: string;
  sessionId: string;
  openAiApiKey?: string;
  defaults: LeadAgentDefaults;
  leadPipelineExecutor: typeof executeLeadSubReactPipeline;
  maxIterations: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxParallelTools: number;
  plannerMaxCalls: number;
  observationWindow: number;
  diminishingThreshold: number;
  toolAllowlist?: string[];
  policyMode: PolicyMode;
  isCancellationRequested: () => Promise<boolean>;
}

interface PlannerDecision {
  thought: string;
  action?: AgentAction;
  stop?: {
    reason: AgentStopReason;
    explanation: string;
  };
  usedFallback: boolean;
  plannerFailureReason?: string;
  llmUsage?: LlmUsage;
}

interface ToolRunResult {
  tool: string;
  status: "ok" | "error";
  durationMs: number;
  output?: Record<string, unknown>;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyLlmUsageTotals(): LlmUsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    callCount: 0
  };
}

function sanitizeTokenValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function normalizeLlmUsage(value: unknown): LlmUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const promptTokens = sanitizeTokenValue((value as { promptTokens?: unknown }).promptTokens);
  const completionTokens = sanitizeTokenValue((value as { completionTokens?: unknown }).completionTokens);
  const totalTokens =
    sanitizeTokenValue((value as { totalTokens?: unknown }).totalTokens) || promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return undefined;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens
  };
}

function parseLlmUsageCallCount(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as { callCount?: unknown }).callCount;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return Math.max(0, Math.round(raw));
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function chooseBudgetMode(previousMode: BudgetMode, ratioFloor: number): BudgetMode {
  if (previousMode === "normal") {
    return ratioFloor < 0.45 ? "conserve" : "normal";
  }
  if (previousMode === "conserve") {
    if (ratioFloor < 0.2) {
      return "emergency";
    }
    if (ratioFloor > 0.6) {
      return "normal";
    }
    return "conserve";
  }
  if (ratioFloor > 0.3) {
    return "conserve";
  }
  return "emergency";
}

function buildBudgetSnapshot(args: {
  mode: BudgetMode;
  remainingMs: number;
  elapsedMs: number;
  maxDurationMs: number;
  toolCallsUsed: number;
  maxToolCalls: number;
  plannerCallsUsed: number;
  plannerMaxCalls: number;
  llmCallsUsed: number;
  llmCallBudget: number;
}): BudgetSnapshot {
  const toolCallsRemaining = Math.max(0, args.maxToolCalls - args.toolCallsUsed);
  const plannerCallsRemaining = Math.max(0, args.plannerMaxCalls - args.plannerCallsUsed);
  const llmCallsRemaining = Math.max(0, args.llmCallBudget - args.llmCallsUsed);

  return {
    mode: args.mode,
    remainingMs: Math.max(0, Math.round(args.remainingMs)),
    elapsedMs: Math.max(0, Math.round(args.elapsedMs)),
    remainingTimeRatio: clampRatio(args.maxDurationMs > 0 ? args.remainingMs / args.maxDurationMs : 0),
    toolCallsRemaining,
    toolCallRatio: clampRatio(args.maxToolCalls > 0 ? toolCallsRemaining / args.maxToolCalls : 0),
    plannerCallsRemaining,
    plannerCallRatio: clampRatio(args.plannerMaxCalls > 0 ? plannerCallsRemaining / args.plannerMaxCalls : 0),
    llmCallsRemaining,
    llmCallRatio: clampRatio(args.llmCallBudget > 0 ? llmCallsRemaining / args.llmCallBudget : 0)
  };
}

export const budgetModesForTests = {
  chooseBudgetMode,
  buildBudgetSnapshot
};

function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|corp|corporation|co|company)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocationKey(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDomain(url: string | undefined): string {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function leadKey(lead: { companyName: string; website?: string; sourceUrl: string; location?: string }): string {
  const company = normalizeCompanyName(lead.companyName);
  const location = normalizeLocationKey(lead.location);
  if (company && location) {
    return `name:${company}|loc:${location}`;
  }
  if (company) {
    return `name:${company}`;
  }

  const websiteDomain = normalizeDomain(lead.website);
  if (websiteDomain) {
    return `domain:${websiteDomain}`;
  }

  const sourceDomain = normalizeDomain(lead.sourceUrl);
  if (sourceDomain) {
    return `source_domain:${sourceDomain}`;
  }

  return `source:${lead.sourceUrl}`;
}

export const leadDedupeForTests = {
  leadKey
};

export const plannerFailureGuardrailsForTests = {
  extractObservationSignals,
  applySearchQueryGuardrail,
  applyDiagnosticStallGuardrail,
  buildReflectionHints
};

export const plannerContextForTests = {
  buildPastActionsSummary,
  buildRecentPerformanceSummary,
  computeYieldPerTokenSignal,
  computeExpectedLlmCapForIteration,
  computeDeficitStrategy,
  buildFailureCodeSummary,
  determineAtomicNextActionHint
};

function summarizeToolResult(result: ToolRunResult): string {
  if (result.status === "error") {
    return `${result.tool} failed: ${result.error}`;
  }

  const output = result.output ?? {};
  if (result.tool === "recover_search") {
    const recovery = output.recovery as
      | {
          recovered?: unknown;
          reason?: unknown;
          exitCode?: unknown;
          signal?: unknown;
          spawnError?: unknown;
          stderrSnippet?: unknown;
        }
      | undefined;
    const recovered = recovery?.recovered === true;
    const reason = typeof recovery?.reason === "string" ? recovery.reason : "unknown";
    const details: string[] = [];
    if (typeof recovery?.exitCode === "number") {
      details.push(`exit=${recovery.exitCode}`);
    }
    if (typeof recovery?.signal === "string" && recovery.signal.length > 0) {
      details.push(`signal=${recovery.signal}`);
    }
    if (typeof recovery?.spawnError === "string" && recovery.spawnError.length > 0) {
      details.push(`spawnError=${recovery.spawnError.slice(0, 80)}`);
    }
    if (typeof recovery?.stderrSnippet === "string" && recovery.stderrSnippet.length > 0) {
      details.push(`stderr=${recovery.stderrSnippet.slice(0, 80)}`);
    }
    const detailText = details.length > 0 ? ` ${details.join(", ")}` : "";
    return `recover_search ${recovered ? "recovered" : "not_recovered"} (${reason})${detailText}`;
  }

  if (result.tool === "search_status") {
    const primaryHealthy = output.primaryHealthy === true ? "healthy" : "unhealthy";
    const fallbackHealthy = output.fallbackHealthy === true ? "healthy" : "unhealthy";
    const lastRecovery = output.lastPrimaryRecovery as { reason?: unknown; completedAt?: unknown } | undefined;
    const recoveryReason = typeof lastRecovery?.reason === "string" ? lastRecovery.reason : undefined;
    const completedAt = typeof lastRecovery?.completedAt === "string" ? lastRecovery.completedAt : undefined;
    if (recoveryReason) {
      return `search_status primary=${primaryHealthy}, fallback=${fallbackHealthy}, lastRecovery=${recoveryReason}${
        completedAt ? ` @ ${completedAt}` : ""
      }`;
    }
    return `search_status primary=${primaryHealthy}, fallback=${fallbackHealthy}`;
  }

  const leadCount = typeof output.totalLeadCount === "number" ? output.totalLeadCount : undefined;
  const added = typeof output.addedLeadCount === "number" ? output.addedLeadCount : undefined;
  if (typeof leadCount === "number") {
    const searchFailures = typeof output.searchFailureCount === "number" ? output.searchFailureCount : 0;
    const browseFailures = typeof output.browseFailureCount === "number" ? output.browseFailureCount : 0;
    const extractionFailures = typeof output.extractionFailureCount === "number" ? output.extractionFailureCount : 0;
    const cancelled = output.cancelled === true;
    const timedOut = output.timedOut === true;
    const cancelledText = cancelled ? ", cancelled=true" : "";
    const timedOutText = timedOut ? ", timedOut=true" : "";
    const browseText = browseFailures > 0 ? `, browse failures ${browseFailures}` : "";
    const extractionText = extractionFailures > 0 ? `, extraction failures ${extractionFailures}` : "";
    if (searchFailures > 0) {
      return `${result.tool} ok, added ${added ?? 0}, total leads ${leadCount}, search failures ${searchFailures}${browseText}${extractionText}${cancelledText}${timedOutText}`;
    }
    return `${result.tool} ok, added ${added ?? 0}, total leads ${leadCount}${browseText}${extractionText}${cancelledText}${timedOutText}`;
  }

  if (typeof output.resultCount === "number") {
    return `${result.tool} ok, ${output.resultCount} results`;
  }

  if (result.tool === "web_fetch") {
    const pagesFetched = readNumber(output.pagesFetched);
    const browseFailures = readNumber(output.browseFailureCount);
    const searchFailures = readNumber(output.searchFailureCount);
    const provider = typeof output.searchProvider === "string" ? output.searchProvider : undefined;
    const providerText = provider ? ` provider=${provider},` : "";
    return `web_fetch ok,${providerText} pages=${pagesFetched}, browse_failures=${browseFailures}, search_failures=${searchFailures}`;
  }

  if (result.tool === "email_enrich") {
    const updated = readNumber(output.updatedLeadCount);
    const candidateLeads = readNumber(output.candidateLeadCount);
    const coverageAfter =
      typeof output.emailCoverageAfter === "number" && Number.isFinite(output.emailCoverageAfter)
        ? `${(output.emailCoverageAfter * 100).toFixed(1)}%`
        : "n/a";
    return `email_enrich ok, updated=${updated}/${candidateLeads}, coverage_after=${coverageAfter}`;
  }

  return `${result.tool} ok`;
}

const YIELD_TOOL_NAMES = new Set(["lead_pipeline", "lead_extract"]);

function isYieldRelevantAction(calls: Array<{ tool: string }>): boolean {
  return calls.some((call) => YIELD_TOOL_NAMES.has(call.tool));
}

function summarizeLeadPipelineInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const maxPages = typeof input.maxPages === "number" ? Math.round(input.maxPages) : undefined;
  const llmMaxCalls = typeof input.llmMaxCalls === "number" ? Math.round(input.llmMaxCalls) : undefined;
  const extractionBatchSize = typeof input.extractionBatchSize === "number" ? Math.round(input.extractionBatchSize) : undefined;
  const browseConcurrency = typeof input.browseConcurrency === "number" ? Math.round(input.browseConcurrency) : undefined;
  const minConfidence = typeof input.minConfidence === "number" ? Number(input.minConfidence.toFixed(2)) : undefined;
  const runEmailEnrichment = typeof input.runEmailEnrichment === "boolean" ? input.runEmailEnrichment : undefined;

  if (typeof maxPages === "number") {
    parts.push(`maxPages=${maxPages}`);
  }
  if (typeof llmMaxCalls === "number") {
    parts.push(`llmMaxCalls=${llmMaxCalls}`);
  }
  if (typeof extractionBatchSize === "number") {
    parts.push(`batch=${extractionBatchSize}`);
  }
  if (typeof browseConcurrency === "number") {
    parts.push(`concurrency=${browseConcurrency}`);
  }
  if (typeof minConfidence === "number") {
    parts.push(`minConf=${minConfidence}`);
  }
  if (typeof runEmailEnrichment === "boolean") {
    parts.push(`emailEnrichment=${runEmailEnrichment}`);
  }
  return parts.length > 0 ? parts.join(", ") : "default_input";
}

function summarizeActionExecution(calls: Array<{ tool: string; input: Record<string, unknown> }>, results: ToolRunResult[]): string {
  return calls
    .map((call) => {
      const result = results.find((item) => item.tool === call.tool);
      const statusText = result?.status ?? "unknown";
      const output = result?.output ?? {};
      if (call.tool === "lead_pipeline") {
        const added = readNumber(output.addedLeadCount);
        const total = readNumber(output.totalLeadCount);
        return `${call.tool}(${summarizeLeadPipelineInput(call.input)}) ${statusText}, added=${added}, total=${total}`;
      }
      if (call.tool === "search") {
        const resultCount = readNumber(output.resultCount);
        return `${call.tool}(${JSON.stringify(call.input)}) ${statusText}, results=${resultCount}`;
      }
      if (call.tool === "web_fetch") {
        const pagesFetched = readNumber(output.pagesFetched);
        const browseFailures = readNumber(output.browseFailureCount);
        return `${call.tool}(${JSON.stringify(call.input)}) ${statusText}, pages=${pagesFetched}, browseFailures=${browseFailures}`;
      }
      if (call.tool === "email_enrich") {
        const updated = readNumber(output.updatedLeadCount);
        const candidateLeads = readNumber(output.candidateLeadCount);
        return `${call.tool}(${JSON.stringify(call.input)}) ${statusText}, updated=${updated}/${candidateLeads}`;
      }
      return `${call.tool}(${JSON.stringify(call.input)}) ${statusText}`;
    })
    .join(" | ");
}

function buildPastActionsSummary(observations: LeadAgentObservation[], maxChars = 2000, maxItems = 5): string[] {
  const items = observations.slice(-Math.max(1, maxItems)).map((item) => {
    const summary = item.note.replace(/\s+/g, " ").trim().slice(0, 360);
    return `iteration ${item.iteration}: ${summary}`;
  });

  const output: string[] = [];
  let used = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    if (used + item.length > maxChars) {
      continue;
    }
    output.unshift(item);
    used += item.length;
  }

  return output;
}

function buildRecentPerformanceSummary(observations: LeadAgentObservation[], threshold: number): string {
  const recent = observations.slice(-6);
  const yieldRelevant = recent.filter((item) => item.yieldRelevant);
  const diagnostics = recent.filter((item) => !item.yieldRelevant);
  const totalYieldAdded = yieldRelevant.reduce((sum, item) => sum + item.newLeadCount, 0);
  const zeroYieldStreak = yieldRelevant
    .slice()
    .reverse()
    .findIndex((item) => item.newLeadCount >= threshold);
  const normalizedZeroYieldStreak = zeroYieldStreak === -1 ? yieldRelevant.length : zeroYieldStreak;
  const searchFailures = recent.reduce((sum, item) => sum + item.searchFailureCount, 0);
  const extractionFailures = recent.reduce((sum, item) => sum + item.extractionFailureCount, 0);
  const semanticMisses = recent.reduce((sum, item) => sum + (item.semanticMissCount ?? 0), 0);
  const retrievalBlocks = recent.reduce((sum, item) => sum + (item.retrievalBlockedCount ?? 0), 0);
  const yieldSignal = computeYieldPerTokenSignal(yieldRelevant);

  return [
    `yieldAttempts=${yieldRelevant.length}`,
    `yieldAdded=${totalYieldAdded}`,
    `diagnosticActions=${diagnostics.length}`,
    `yieldZeroStreak=${normalizedZeroYieldStreak}`,
    `searchFailures=${searchFailures}`,
    `extractionFailures=${extractionFailures}`,
    `semanticMisses=${semanticMisses}`,
    `retrievalBlocks=${retrievalBlocks}`,
    `yieldPer1kTokens=${yieldSignal.averageLeadsPer1kTokens.toFixed(2)}`,
    `yieldAlert=${yieldSignal.status}`
  ].join(", ");
}

function buildFailureCodeSummary(observations: LeadAgentObservation[], maxItems = 6): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    for (const code of observation.failureCodes ?? []) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, Math.max(1, maxItems));
}

function isEmailRequestedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return /\bemails?\b|\bemail\s+addresses?\b|\bcontact\s+emails?\b/.test(normalized);
}

function isEmailRequired(options: { message: string; leadExecutionBrief?: LeadExecutionBrief }): boolean {
  if (typeof options.leadExecutionBrief?.emailRequired === "boolean") {
    return options.leadExecutionBrief.emailRequired;
  }
  return isEmailRequestedMessage(options.message);
}

function computeDeficitStrategy(args: {
  requestedLeadCount: number;
  currentLeadCount: number;
  mode: BudgetMode;
  emailRequested: boolean;
}): DeficitStrategy {
  const deficit = Math.max(0, args.requestedLeadCount - args.currentLeadCount);
  const threshold = args.mode === "emergency" ? 3 : 5;
  if (deficit <= threshold) {
    return {
      deficit,
      threshold,
      recommendation: "polish_only",
      emailRequested: args.emailRequested
    };
  }
  return {
    deficit,
    threshold,
    recommendation: "growth",
    emailRequested: args.emailRequested
  };
}

function computeExpectedLlmCapForIteration(args: {
  mode: BudgetMode;
  observations: LeadAgentObservation[];
  highYieldThreshold: number;
}): number {
  const sequenceByMode: Record<BudgetMode, number[]> = {
    normal: [12, 12, 12],
    conserve: [12, 10, 8],
    emergency: [12, 6, 3]
  };
  const sequence = sequenceByMode[args.mode];
  const sameModeStreak = (() => {
    let streak = 0;
    for (let index = args.observations.length - 1; index >= 0; index -= 1) {
      const item = args.observations[index];
      if (!item || item.budgetMode !== args.mode) {
        break;
      }
      streak += 1;
    }
    return streak;
  })();

  let cap = sequence[Math.min(sameModeStreak, sequence.length - 1)] ?? sequence[sequence.length - 1] ?? 12;
  const last = args.observations.at(-1);
  if (last?.yieldRelevant && last.newLeadCount >= args.highYieldThreshold) {
    cap += args.mode === "emergency" ? 1 : 2;
  }
  if (last?.hadLlmBudgetExhausted) {
    cap = Math.max(1, cap - 2);
  }
  return Math.max(1, Math.min(20, cap));
}

const DEFAULT_YIELD_PER_1K_TOKEN_THRESHOLD = 0.5;

function computeYieldPerTokenSignal(
  observations: LeadAgentObservation[],
  threshold = DEFAULT_YIELD_PER_1K_TOKEN_THRESHOLD
): YieldSignal {
  const recent = observations.filter((item) => item.yieldRelevant).slice(-2);
  if (recent.length < 2) {
    return {
      status: "insufficient",
      averageLeadsPer1kTokens: 0,
      sampleCount: recent.length,
      threshold
    };
  }

  const leads = recent.reduce((sum, item) => sum + Math.max(0, item.newLeadCount), 0);
  const tokens = recent.reduce((sum, item) => sum + Math.max(0, item.llmTokensUsed), 0);
  const averageLeadsPer1kTokens = tokens > 0 ? leads / (tokens / 1000) : leads > 0 ? threshold + 1 : 0;
  return {
    status: averageLeadsPer1kTokens < threshold ? "low" : "ok",
    averageLeadsPer1kTokens,
    sampleCount: recent.length,
    threshold
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractObservationSignals(results: ToolRunResult[]): {
  searchFailureCount: number;
  browseFailureCount: number;
  extractionFailureCount: number;
  semanticMissCount: number;
  retrievalBlockedCount: number;
  failureCodes: string[];
  hadLlmBudgetExhausted: boolean;
} {
  let searchFailureCount = 0;
  let browseFailureCount = 0;
  let extractionFailureCount = 0;
  let semanticMissCount = 0;
  let retrievalBlockedCount = 0;
  let hadLlmBudgetExhausted = false;
  const failureCodes = new Set<string>();

  for (const result of results) {
    const output = result.output ?? {};
    if (result.tool === "search" && result.status === "error") {
      searchFailureCount += 1;
    }
    searchFailureCount += readNumber(output.searchFailureCount);
    browseFailureCount += readNumber(output.browseFailureCount);
    extractionFailureCount += readNumber(output.extractionFailureCount);
    const rawCandidateCount = readNumber(output.rawCandidateCount);
    const pagesVisited = readNumber(output.pagesVisited);
    const queryCount = readNumber(output.queryCount);
    const toolSearchFailures = readNumber(output.searchFailureCount);
    const toolExtractionFailures = readNumber(output.extractionFailureCount);
    const finalCandidateCount = readNumber(output.finalCandidateCount);
    const emailCoverageRatio =
      typeof output.emailCoverageRatio === "number" && Number.isFinite(output.emailCoverageRatio)
        ? output.emailCoverageRatio
        : undefined;

    if (result.status === "error") {
      failureCodes.add("tool_error");
    }
    if (toolSearchFailures > 0) {
      failureCodes.add("search_unhealthy");
    }
    if (pagesVisited > 0 && rawCandidateCount === 0 && toolSearchFailures === 0 && toolExtractionFailures === 0) {
      semanticMissCount += 1;
      failureCodes.add("semantic_miss");
    }
    if (queryCount > 0 && pagesVisited === 0 && toolSearchFailures > 0) {
      retrievalBlockedCount += 1;
      failureCodes.add("search_retrieval_blocked");
    }
    if (toolExtractionFailures > 0) {
      failureCodes.add("extraction_failure");
    }
    if (finalCandidateCount > 0 && typeof emailCoverageRatio === "number" && emailCoverageRatio < 0.3) {
      failureCodes.add("low_email_coverage");
    }

    const extractionSamples = Array.isArray(output.extractionFailureSamples) ? output.extractionFailureSamples : [];
    if (
      extractionSamples.some((sample) => {
        const reason = typeof (sample as { reason?: unknown }).reason === "string" ? (sample as { reason: string }).reason : "";
        return reason.includes("llm_budget_exhausted");
      })
    ) {
      hadLlmBudgetExhausted = true;
      failureCodes.add("llm_budget_exhausted");
    }
  }

  return {
    searchFailureCount,
    browseFailureCount,
    extractionFailureCount,
    semanticMissCount,
    retrievalBlockedCount,
    failureCodes: Array.from(failureCodes).sort(),
    hadLlmBudgetExhausted
  };
}

function fallbackSearchQueryFromMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length >= 2) {
    return normalized.slice(0, 320);
  }
  return "find company leads matching the user objective";
}

function fallbackSearchQueryFromBrief(message: string, brief?: LeadExecutionBrief): string {
  const briefSummary = brief?.objectiveBrief?.objectiveSummary?.replace(/\s+/g, " ").trim();
  if (briefSummary && briefSummary.length >= 2) {
    return briefSummary.slice(0, 320);
  }
  return fallbackSearchQueryFromMessage(message);
}

function normalizeSearchQuery(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length >= 2 ? normalized.slice(0, 320) : undefined;
}

function applySearchQueryGuardrail(
  calls: Array<{ tool: string; input: Record<string, unknown> }>,
  message: string,
  leadExecutionBrief?: LeadExecutionBrief
): {
  calls: Array<{ tool: string; input: Record<string, unknown> }>;
  adjusted: boolean;
  reason?: string;
} {
  let adjusted = false;
  const fallbackQuery = fallbackSearchQueryFromBrief(message, leadExecutionBrief);
  const nextCalls = calls.map((call) => {
    if (call.tool !== "search" && call.tool !== "lead_search_shortlist") {
      return call;
    }
    const query = normalizeSearchQuery(call.input.query);
    const nextInput: Record<string, unknown> = {
      ...call.input,
      query: query ?? fallbackQuery
    };

    if (query === undefined) {
      adjusted = true;
    }

    if (call.tool === "lead_search_shortlist") {
      const maxResultsValue = call.input.maxResults;
      if (typeof maxResultsValue === "number" && Number.isFinite(maxResultsValue)) {
        const clamped = Math.max(1, Math.min(15, Math.round(maxResultsValue)));
        if (clamped !== maxResultsValue) {
          adjusted = true;
        }
        nextInput.maxResults = clamped;
      }
      const maxUrlsValue = call.input.maxUrls;
      if (typeof maxUrlsValue === "number" && Number.isFinite(maxUrlsValue)) {
        const clamped = Math.max(1, Math.min(25, Math.round(maxUrlsValue)));
        if (clamped !== maxUrlsValue) {
          adjusted = true;
        }
        nextInput.maxUrls = clamped;
      }
    }

    return {
      ...call,
      input: nextInput
    };
  });

  return {
    calls: nextCalls,
    adjusted,
    reason: adjusted ? "search_query_or_shortlist_input_adjusted" : undefined
  };
}

function applyDiagnosticStallGuardrail(args: {
  action: AgentAction;
  observations: LeadAgentObservation[];
  availableToolNames: Set<string>;
  objectiveQuery: string;
}): {
  action: AgentAction;
  adjusted: boolean;
  reason?: string;
} {
  if (args.action.type !== "single" || args.action.tool !== "search_status") {
    return { action: args.action, adjusted: false };
  }

  const recent = args.observations.slice(-2);
  const repeatedSearchStatus =
    recent.length >= 2 &&
    recent.every(
      (item) =>
        item.toolNames.length === 1 &&
        item.toolNames[0] === "search_status" &&
        item.newLeadCount === 0 &&
        item.failedToolCount === 0
    );
  if (!repeatedSearchStatus) {
    return { action: args.action, adjusted: false };
  }

  if (args.availableToolNames.has("recover_search")) {
    return {
      action: {
        type: "single",
        tool: "recover_search",
        input: {}
      },
      adjusted: true,
      reason: "repeated_search_status_without_progress"
    };
  }

  if (args.availableToolNames.has("lead_search_shortlist")) {
    return {
      action: {
        type: "single",
        tool: "lead_search_shortlist",
        input: {
          query: args.objectiveQuery,
          maxResults: 12,
          maxUrls: 8
        }
      },
      adjusted: true,
      reason: "repeated_search_status_without_progress"
    };
  }

  return { action: args.action, adjusted: false };
}

function buildReflectionHints(
  observations: LeadAgentObservation[],
  threshold: number
): string[] {
  const hints: string[] = [];
  const lastObservation = observations.at(-1);
  if (
    lastObservation &&
    lastObservation.searchFailureCount > 0 &&
    !lastObservation.toolNames.includes("search_status") &&
    !lastObservation.toolNames.includes("recover_search")
  ) {
    hints.push(
      "Recent search failures occurred before any recovery check. Consider using search_status first and recover_search if the provider looks unhealthy before retrying deep discovery."
    );
  }

  const recentLeadAttempts = observations
    .filter((item) => item.yieldRelevant && item.toolNames.includes("lead_pipeline"))
    .slice(-2);
  if (recentLeadAttempts.length < 2) {
    return hints;
  }

  const repeatedLowYield = recentLeadAttempts.every((item) => item.newLeadCount < threshold);
  if (!repeatedLowYield) {
    return hints;
  }

  const hadSemanticMiss = recentLeadAttempts.some(
    (item) => (item.semanticMissCount ?? 0) > 0 || (item.failureCodes ?? []).includes("semantic_miss")
  );
  if (!hadSemanticMiss) {
    return hints;
  }

  const recentInputSummaries = recentLeadAttempts.flatMap((item) => item.leadPipelineInputSummaries ?? []);
  if (recentInputSummaries.length === 0) {
    return hints;
  }

  hints.push(
    `Two recent lead_pipeline attempts were low-yield with semantic miss signals. Avoid repeating the same pipeline shape (${recentInputSummaries.slice(-2).join(" | ")}). Broaden retrieval strategy, diversify search wording or domains, or reduce strictness before another deep pass.`
  );
  return hints;
}

function buildDeterministicAssistantSummary(args: {
  leadCount: number;
  requestedLeadCount: number;
  stopReason: AgentStopReason;
  stopExplanation: string;
  totalToolCalls: number;
  maxToolCalls: number;
  plannerCallsUsed: number;
  plannerMaxCalls: number;
  elapsedMs: number;
  observations: LeadAgentObservation[];
  stateLeads: LeadAgentState["leads"];
  llmUsageTotals: LlmUsageTotals;
  budgetSnapshot: BudgetSnapshot;
}): string {
  const deficitCount = Math.max(0, args.requestedLeadCount - args.leadCount);
  const emailLeadCount = args.stateLeads.filter((lead) => Boolean(lead.email)).length;
  const emailCoverageRatio = args.leadCount > 0 ? emailLeadCount / args.leadCount : 0;

  let searchFailureCount = 0;
  let browseFailureCount = 0;
  let extractionFailureCount = 0;
  let semanticMissCount = 0;
  let retrievalBlockedCount = 0;
  for (const observation of args.observations) {
    searchFailureCount += observation.searchFailureCount;
    browseFailureCount += observation.browseFailureCount;
    extractionFailureCount += observation.extractionFailureCount;
    semanticMissCount += observation.semanticMissCount ?? 0;
    retrievalBlockedCount += observation.retrievalBlockedCount ?? 0;
  }

  return [
    `Leads collected: ${args.leadCount}/${args.requestedLeadCount} (deficit ${deficitCount}).`,
    `Email coverage: ${emailLeadCount}/${args.leadCount} (${(emailCoverageRatio * 100).toFixed(1)}%).`,
    `Observed failures: search ${searchFailureCount}, browse ${browseFailureCount}, extraction ${extractionFailureCount}, semantic_miss ${semanticMissCount}, retrieval_blocked ${retrievalBlockedCount}.`,
    `LLM usage: ${args.llmUsageTotals.totalTokens} total tokens (${args.llmUsageTotals.promptTokens} prompt, ${args.llmUsageTotals.completionTokens} completion) across ${args.llmUsageTotals.callCount} calls.`,
    `Budget snapshot: mode=${args.budgetSnapshot.mode}, time ${(args.budgetSnapshot.remainingTimeRatio * 100).toFixed(0)}% (${Math.round(
      args.budgetSnapshot.remainingMs / 1000
    )}s) left, tool ${(args.budgetSnapshot.toolCallRatio * 100).toFixed(0)}% (${args.budgetSnapshot.toolCallsRemaining}) left, planner ${(
      args.budgetSnapshot.plannerCallRatio * 100
    ).toFixed(0)}% (${args.budgetSnapshot.plannerCallsRemaining}) left, llm ${(args.budgetSnapshot.llmCallRatio * 100).toFixed(0)}% (${args.budgetSnapshot.llmCallsRemaining}) left.`,
    `Stop: ${args.stopReason} (${args.stopExplanation}) | Tool calls ${args.totalToolCalls}/${args.maxToolCalls}, planner calls ${args.plannerCallsUsed}/${args.plannerMaxCalls}, elapsed ${Math.round(args.elapsedMs / 1000)}s.`
  ].join("\n");
}

function computeDiminishingReturns(history: LeadAgentObservation[], threshold: number): boolean {
  const yieldHistory = history.filter((item) => item.yieldRelevant);
  if (yieldHistory.length < 2) {
    return false;
  }

  const lastTwo = yieldHistory.slice(-2);
  return lastTwo.every((item) => item.newLeadCount < threshold);
}

function computeDynamicIterationCeiling(args: {
  configuredMaxIterations: number;
  observations: LeadAgentObservation[];
  budgetSnapshot: BudgetSnapshot;
  requestedLeadCount: number;
  currentLeadCount: number;
  diminishingThreshold: number;
}): number {
  const configured = Math.max(2, args.configuredMaxIterations);
  let ceiling = Math.min(configured, 4);
  const deficit = Math.max(0, args.requestedLeadCount - args.currentLeadCount);
  const highDeficit = deficit > Math.max(5, Math.ceil(args.requestedLeadCount * 0.25));

  if (
    highDeficit &&
    args.budgetSnapshot.remainingTimeRatio > 0.35 &&
    args.budgetSnapshot.llmCallRatio > 0.35 &&
    args.budgetSnapshot.plannerCallRatio > 0.2
  ) {
    ceiling = Math.min(configured, ceiling + 2);
  }

  const last = args.observations.at(-1);
  if (last?.yieldRelevant && last.newLeadCount >= Math.max(2, args.diminishingThreshold)) {
    ceiling = Math.min(configured, ceiling + 1);
  }

  if (args.budgetSnapshot.mode === "emergency") {
    ceiling = Math.min(ceiling, Math.max(2, Math.min(configured, 3)));
  }

  return Math.max(2, Math.min(configured, ceiling));
}

interface LeadPipelineModeBounds {
  maxPages: number;
  llmMaxCalls: number;
  browseConcurrency: number;
  extractionBatchSize: number;
}

function minLeadPipelineStartMsForMode(mode: BudgetMode): number {
  if (mode === "emergency") {
    return 5_000;
  }
  if (mode === "conserve") {
    return 15_000;
  }
  return 30_000;
}

function leadPipelineBoundsForMode(mode: BudgetMode): LeadPipelineModeBounds {
  if (mode === "emergency") {
    return {
      maxPages: 5,
      llmMaxCalls: 6,
      browseConcurrency: 2,
      extractionBatchSize: 2
    };
  }
  if (mode === "conserve") {
    return {
      maxPages: 12,
      llmMaxCalls: 10,
      browseConcurrency: 3,
      extractionBatchSize: 3
    };
  }
  return {
    maxPages: 25,
    llmMaxCalls: 12,
    browseConcurrency: 6,
    extractionBatchSize: 6
  };
}

function applyLeadPipelineTimeBudget(
  input: Record<string, unknown>,
  remainingMs: number,
  mode: BudgetMode,
  expectedLlmCapThisIteration?: number
): Record<string, unknown> {
  const adjusted = { ...input };
  const modeBounds = leadPipelineBoundsForMode(mode);
  const expectedLlmCap =
    typeof expectedLlmCapThisIteration === "number" && Number.isFinite(expectedLlmCapThisIteration)
      ? Math.max(1, Math.min(20, Math.round(expectedLlmCapThisIteration)))
      : undefined;

  const clampByMode = () => {
    const maxPages = typeof adjusted.maxPages === "number" ? adjusted.maxPages : modeBounds.maxPages;
    adjusted.maxPages = Math.min(modeBounds.maxPages, Math.max(1, Math.round(maxPages)));
    const llmMaxCalls = typeof adjusted.llmMaxCalls === "number" ? adjusted.llmMaxCalls : modeBounds.llmMaxCalls;
    adjusted.llmMaxCalls = Math.min(modeBounds.llmMaxCalls, Math.max(1, Math.round(llmMaxCalls)));
    const browseConcurrency =
      typeof adjusted.browseConcurrency === "number" ? adjusted.browseConcurrency : modeBounds.browseConcurrency;
    adjusted.browseConcurrency = Math.min(modeBounds.browseConcurrency, Math.max(1, Math.round(browseConcurrency)));
    const extractionBatchSize =
      typeof adjusted.extractionBatchSize === "number" ? adjusted.extractionBatchSize : modeBounds.extractionBatchSize;
    adjusted.extractionBatchSize = Math.min(modeBounds.extractionBatchSize, Math.max(1, Math.round(extractionBatchSize)));
  };
  const clampByExpectedLlmCap = () => {
    if (typeof expectedLlmCap !== "number") {
      return;
    }
    const llmMaxCalls = typeof adjusted.llmMaxCalls === "number" ? adjusted.llmMaxCalls : expectedLlmCap;
    adjusted.llmMaxCalls = Math.min(expectedLlmCap, Math.max(1, Math.round(llmMaxCalls)));
  };

  clampByMode();
  clampByExpectedLlmCap();

  if (remainingMs < 180_000) {
    const maxPages = typeof adjusted.maxPages === "number" ? adjusted.maxPages : 12;
    adjusted.maxPages = Math.min(12, Math.max(1, Math.round(maxPages)));
    const llmMaxCalls = typeof adjusted.llmMaxCalls === "number" ? adjusted.llmMaxCalls : 4;
    adjusted.llmMaxCalls = Math.min(4, Math.max(1, Math.round(llmMaxCalls)));
    const browseConcurrency = typeof adjusted.browseConcurrency === "number" ? adjusted.browseConcurrency : 2;
    adjusted.browseConcurrency = Math.min(2, Math.max(1, Math.round(browseConcurrency)));
    const extractionBatchSize = typeof adjusted.extractionBatchSize === "number" ? adjusted.extractionBatchSize : 3;
    adjusted.extractionBatchSize = Math.min(3, Math.max(1, Math.round(extractionBatchSize)));
  }

  if (remainingMs < 120_000) {
    const maxPages = typeof adjusted.maxPages === "number" ? adjusted.maxPages : 8;
    adjusted.maxPages = Math.min(8, Math.max(1, Math.round(maxPages)));
    const llmMaxCalls = typeof adjusted.llmMaxCalls === "number" ? adjusted.llmMaxCalls : 3;
    adjusted.llmMaxCalls = Math.min(3, Math.max(1, Math.round(llmMaxCalls)));
  }

  clampByMode();
  clampByExpectedLlmCap();
  return adjusted;
}

export const budgetGuardrailsForTests = {
  applyLeadPipelineTimeBudget,
  minLeadPipelineStartMsForMode,
  leadPipelineBoundsForMode,
  computeDynamicIterationCeiling
};

export const diminishingReturnsForTests = {
  computeDiminishingReturns
};

function highDeficitThreshold(requestedLeadCount: number): number {
  return Math.max(6, Math.ceil(requestedLeadCount * 0.35));
}

export function determineAdaptiveMinConfidence(
  iteration: number,
  requestedLeadCount: number,
  currentLeadCount: number
): number {
  if (iteration <= 1) {
    return 0.7;
  }

  if (iteration === 2) {
    return 0.65;
  }

  const deficit = Math.max(0, requestedLeadCount - currentLeadCount);
  return deficit >= highDeficitThreshold(requestedLeadCount) ? 0.6 : 0.65;
}

function applyLeadPipelineActionDefaults(
  input: Record<string, unknown>,
  iteration: number,
  requestedLeadCount: number,
  currentLeadCount: number
): Record<string, unknown> {
  if (typeof input.minConfidence === "number") {
    return input;
  }

  return {
    ...input,
    minConfidence: determineAdaptiveMinConfidence(iteration, requestedLeadCount, currentLeadCount)
  };
}

function determineAtomicNextActionHint(args: {
  objectiveQuery: string;
  shortlistedUrlsCount: number;
  fetchedPagesCount: number;
  leadCount: number;
  emailRequested: boolean;
  budgetMode: BudgetMode;
  expectedLlmCapThisIteration: number;
  targetLeadCount: number;
}): AtomicNextActionHint {
  if (args.emailRequested && args.leadCount > 0) {
    return {
      tool: "email_enrich",
      input: {},
      rationale: "Lead candidates already exist, so improve email coverage before gathering more pages."
    };
  }

  if (args.fetchedPagesCount > 0) {
    return {
      tool: "lead_extract",
      input: {
        llmMaxCalls: args.expectedLlmCapThisIteration,
        minConfidence: determineAdaptiveMinConfidence(1, args.targetLeadCount, args.leadCount)
      },
      rationale: "Pages are already fetched, so extract leads from the current evidence before browsing more."
    };
  }

  if (args.shortlistedUrlsCount > 0) {
    return {
      tool: "web_fetch",
      input: {
        useStoredUrls: true,
        maxPages: args.budgetMode === "emergency" ? 5 : 8
      },
      rationale: "Shortlisted URLs already exist, so fetch them before running a broader pipeline pass."
    };
  }

  return {
    tool: "lead_search_shortlist",
    input: {
      query: args.objectiveQuery,
      maxResults: args.budgetMode === "emergency" ? 8 : 12,
      maxUrls: args.budgetMode === "emergency" ? 5 : 8
    },
    rationale: "Start with URL shortlist hygiene so the first retrieval step is lighter than a full pipeline run."
  };
}

function fallbackPlan(args: {
  iteration: number;
  defaults: LeadAgentDefaults;
  leadCount: number;
  targetLeadCount: number;
  fetchedPagesCount: number;
  shortlistedUrlsCount: number;
  objectiveQuery: string;
  emailRequested: boolean;
  budgetMode: BudgetMode;
  deficitStrategy: DeficitStrategy;
  expectedLlmCapThisIteration: number;
  hasPolishTools: boolean;
}): PlannerDecision {
  const atomicHint = determineAtomicNextActionHint(args);
  if (args.leadCount >= args.targetLeadCount) {
    return {
      thought: "Target reached.",
      stop: { reason: "target_met", explanation: "Collected enough leads to satisfy requested target." },
      usedFallback: true
    };
  }

  if (args.deficitStrategy.recommendation === "polish_only" && !args.hasPolishTools) {
    return {
      thought: "No polish tools are available.",
      stop: {
        reason: "manual_guardrail",
        explanation: "Deficit is small but no polish-capable tools are available, so stopping gracefully."
      },
      usedFallback: true
    };
  }

  if (args.deficitStrategy.recommendation === "polish_only") {
    if (args.fetchedPagesCount > 0) {
      return {
        thought: "Deficit is small and pages are already fetched, so extracting from current pages first.",
        action: {
          type: "single",
          tool: "lead_extract",
          input: {
            llmMaxCalls: Math.min(args.expectedLlmCapThisIteration, args.budgetMode === "emergency" ? 3 : 6),
            minConfidence: determineAdaptiveMinConfidence(args.iteration, args.targetLeadCount, args.leadCount)
          }
        },
        usedFallback: true
      };
    }
    if (args.shortlistedUrlsCount > 0) {
      return {
        thought: "Deficit is small and shortlisted URLs already exist, so fetch those pages before escalating.",
        action: {
          type: "single",
          tool: "web_fetch",
          input: {
            useStoredUrls: true,
            maxPages: args.budgetMode === "emergency" ? 4 : 6
          }
        },
        usedFallback: true
      };
    }
    return {
      thought: "Deficit is small, so running polish-only refinement.",
      action: {
        type: "single",
        tool: "lead_pipeline",
        input: {
          maxPages: args.budgetMode === "emergency" ? 5 : 8,
          extractionBatchSize: args.budgetMode === "emergency" ? 2 : 3,
          llmMaxCalls: Math.min(args.expectedLlmCapThisIteration, args.budgetMode === "emergency" ? 3 : 6),
          runEmailEnrichment: true,
          minConfidence: determineAdaptiveMinConfidence(args.iteration, args.targetLeadCount, args.leadCount)
        }
      },
      usedFallback: true
    };
  }

  if (args.iteration === 1) {
    return {
      thought: atomicHint.rationale,
      action: {
        type: "single",
        tool: atomicHint.tool,
        input: atomicHint.input
      },
      usedFallback: true
    };
  }

  if (args.iteration === 2) {
    if (args.fetchedPagesCount > 0) {
      return {
        thought: "Pages are already fetched, so extract leads before broadening the crawl.",
        action: {
          type: "single",
          tool: "lead_extract",
          input: {
            llmMaxCalls: args.expectedLlmCapThisIteration,
            minConfidence: determineAdaptiveMinConfidence(args.iteration, args.targetLeadCount, args.leadCount)
          }
        },
        usedFallback: true
      };
    }
    if (args.shortlistedUrlsCount > 0) {
      return {
        thought: "Shortlisted URLs already exist, so fetch them before broadening the crawl.",
        action: {
          type: "single",
          tool: "web_fetch",
          input: {
            useStoredUrls: true,
            maxPages: args.budgetMode === "emergency" ? 5 : 8
          }
        },
        usedFallback: true
      };
    }
    return {
      thought: "Increase crawl depth to improve recall.",
      action: {
        type: "single",
        tool: "lead_pipeline",
        input: {
          maxPages: Math.min(20, args.defaults.subReactMaxPages + 5),
          minConfidence: determineAdaptiveMinConfidence(args.iteration, args.targetLeadCount, args.leadCount),
          llmMaxCalls: args.expectedLlmCapThisIteration
        }
      },
      usedFallback: true
    };
  }

  if (args.iteration === 3) {
    if (args.emailRequested && args.leadCount > 0) {
      return {
        thought: "Lead candidates exist, so improve email coverage before persisting.",
        action: {
          type: "single",
          tool: "email_enrich",
          input: {}
        },
        usedFallback: true
      };
    }
    return {
      thought: "Persist current leads.",
      action: { type: "single", tool: "write_csv", input: {} },
      usedFallback: true
    };
  }

  return {
    thought: "Fallback planner completed baseline/deeper passes.",
    stop: {
      reason: "diminishing_returns",
      explanation: "Fallback planner stopped after baseline, deep pass, and persistence checkpoint."
    },
    usedFallback: true
  };
}

function buildLeadPlannerSystemPrompt(): string {
  const plannerDirectives =
    "Decide the next best tool action (single or parallel) to reach lead targets. Prefer actions that improve yield and avoid unnecessary calls. Prioritize lead-focused tools (lead_search_shortlist, web_fetch, lead_extract, email_enrich, lead_pipeline, search_status, recover_search, write_csv); only use filesystem/shell/process tools when they are strictly required for debugging or recovery. Prefer the atomic path when it is viable: lead_search_shortlist -> web_fetch -> lead_extract -> email_enrich -> write_csv. Use lead_pipeline as a compatibility shortcut when the atomic path is clearly lower leverage, you need an end-to-end recovery pass quickly, or you need broader recall than the current fetched-page state can provide. You will receive structured failure signals per iteration (searchFailureCount, browseFailureCount, extractionFailureCount, semanticMissCount, retrievalBlockedCount, hadLlmBudgetExhausted), a capped pastActionsSummary, recentPerformanceSummary, failureCodeSummary, optional reflectionHints, and a recommendedAtomicNextAction derived from current state. Treat all of these as informative signals, not rigid deterministic instructions. React to failures explicitly: if searchFailureCount > 0, check provider health before blindly retrying deep lead discovery; if semanticMissCount > 0, prefer retrieval strategy changes (query diversification, directory-focused search, lighter fetch passes) before repeating identical lead_pipeline settings. If hadLlmBudgetExhausted is true, reduce llmMaxCalls/extraction scope on the next extraction action. If failedToolCount > 0 across recent observations, your thought must acknowledge that failure signal before choosing the next action. Budget mode is dynamic: when budgetMode is conserve or emergency, prioritize high-yield/low-cost actions (search_status, lead_search_shortlist, web_fetch, lead_extract) before deep full-pipeline runs; use smaller lead_pipeline inputs and avoid expensive retries unless signal quality is high. If budget.remainingMs < 60000, prefer lightweight diagnostic/retrieval actions or stop instead of launching heavy pipelines. Honor expectedCapThisIteration by keeping extraction llmMaxCalls at or below that value unless there is a strong, explicit reason. If deficitStrategy.recommendation is polish_only, choose lightweight polishing actions over broad discovery; if no polish-capable tools exist, stop with explanation. If yieldSignal.status is low, explicitly choose one diversification strategy and mention it in thought: strategy=query_diversify | strategy=relax_confidence | strategy=volume_no_email | strategy=deeper_crawl | strategy=stop. Avoid repeating identical search queries across consecutive low-yield iterations; diversify query wording using the user objective, nearby synonyms, and alternate directory sources. For lead_pipeline actions, you may set runEmailEnrichment=false when budget is constrained and lead deficit remains high, then use email_enrich later on shortlisted leads. Use pastActionsSummary, recentPerformanceSummary, reflectionHints, and recommendedAtomicNextAction to avoid repeating low-yield actions with nearly identical inputs. Treat service recovery as agentic work you should attempt before stopping. Respect tool constraints: lead_pipeline.maxPages <= 25, browseConcurrency <= 6, extractionBatchSize <= 6, llmMaxCalls <= 20, minConfidence between 0 and 1. For action inputs, always return inputJson as a valid JSON object string (for example: \"{}\" or \"{\\\"maxPages\\\":20}\").";

  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: `Domain ${LEAD_DOMAIN_PROMPT_VERSION}`,
      content: LEAD_GENERATION_DOMAIN_SYSTEM_PROMPT
    },
    {
      label: `Role ${LEAD_PLANNER_ROLE_PROMPT_VERSION}`,
      content: LEAD_PLANNER_ROLE_SYSTEM_PROMPT
    },
    {
      label: "Planner Directives",
      content: plannerDirectives
    }
  ]);
}

function formatLeadExecutionBriefForPrompt(brief?: LeadExecutionBrief): string | undefined {
  if (!brief) {
    return undefined;
  }
  return JSON.stringify({
    requestedLeadCount: brief.requestedLeadCount,
    emailRequired: brief.emailRequired ?? false,
    outputFormat: brief.outputFormat ?? null,
    objectiveBrief: brief.objectiveBrief
  });
}

function parseToolInputJson(inputJson: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizePlannerAction(output: PlannerOutput, maxParallelTools: number): AgentAction | undefined {
  if (output.actionType === "single") {
    if (!output.singleAction) {
      return undefined;
    }
    const input = parseToolInputJson(output.singleAction.inputJson);
    if (!input) {
      return undefined;
    }
    return {
      type: "single",
      tool: output.singleAction.tool,
      input
    };
  }

  if (output.actionType === "parallel") {
    const tools = (output.parallelActions ?? [])
      .slice(0, Math.max(1, maxParallelTools))
      .flatMap((item) => {
        const input = parseToolInputJson(item.inputJson);
        if (!input) {
          return [];
        }
        return [{ tool: item.tool, input }];
      });
    if (tools.length === 0) {
      return undefined;
    }
    return {
      type: "parallel",
      tools
    };
  }

  return undefined;
}

async function decidePlannerAction(
  options: LeadAgentRuntimeOptions,
  plannerBudget: LlmBudgetManager,
  availableTools: Array<{ name: string; description: string; inputHint: string }>,
  iteration: number,
  state: LeadAgentState,
  observations: LeadAgentObservation[],
  budgetSnapshot: BudgetSnapshot,
  expectedLlmCapThisIteration: number,
  deficitStrategy: DeficitStrategy,
  yieldSignal: YieldSignal
): Promise<PlannerDecision> {
  const toolNames = new Set(availableTools.map((tool) => tool.name));
  const hasPolishTools = toolNames.has("lead_pipeline") || toolNames.has("lead_extract") || toolNames.has("write_csv");
  const objectiveQuery = fallbackSearchQueryFromBrief(options.message, options.leadExecutionBrief);
  if (!options.openAiApiKey || !plannerBudget.consume()) {
    return fallbackPlan({
      iteration,
      defaults: options.defaults,
      leadCount: state.leads.length,
      targetLeadCount: state.requestedLeadCount,
      fetchedPagesCount: state.fetchedPages.length,
      shortlistedUrlsCount: state.shortlistedUrls?.length ?? 0,
      objectiveQuery,
      emailRequested: deficitStrategy.emailRequested,
      budgetMode: budgetSnapshot.mode,
      deficitStrategy,
      expectedLlmCapThisIteration,
      hasPolishTools
    });
  }

  const lastObservations = observations.slice(-options.observationWindow);
  const pastActionsSummary = buildPastActionsSummary(lastObservations);
  const recentPerformanceSummary = buildRecentPerformanceSummary(lastObservations, options.diminishingThreshold);
  const reflectionHints = buildReflectionHints(lastObservations, options.diminishingThreshold);
  const leadDeficit = deficitStrategy.deficit;
  const emailStrategyHint =
    budgetSnapshot.mode === "normal"
      ? "normal_mode: email enrichment is acceptable when it improves confidence."
      : leadDeficit > 10
        ? "low_budget_high_deficit: prioritize lead discovery; for lead_pipeline actions consider runEmailEnrichment=false."
        : "low_budget_low_deficit: selective email enrichment is acceptable when coverage is low.";
  const aggregateFailures = lastObservations.reduce(
    (acc, item) => {
      acc.failedToolCount += item.failedToolCount;
      acc.searchFailureCount += item.searchFailureCount;
      acc.browseFailureCount += item.browseFailureCount;
      acc.extractionFailureCount += item.extractionFailureCount;
      acc.semanticMissCount += item.semanticMissCount ?? 0;
      acc.retrievalBlockedCount += item.retrievalBlockedCount ?? 0;
      acc.hadLlmBudgetExhausted = acc.hadLlmBudgetExhausted || item.hadLlmBudgetExhausted;
      return acc;
    },
    {
      failedToolCount: 0,
      searchFailureCount: 0,
      browseFailureCount: 0,
      extractionFailureCount: 0,
      semanticMissCount: 0,
      retrievalBlockedCount: 0,
      hadLlmBudgetExhausted: false
    }
  );
  const failureCodeSummary = buildFailureCodeSummary(lastObservations);
  const recommendedAtomicNextAction = determineAtomicNextActionHint({
    objectiveQuery,
    shortlistedUrlsCount: state.shortlistedUrls?.length ?? 0,
    fetchedPagesCount: state.fetchedPages.length,
    leadCount: state.leads.length,
    emailRequested: deficitStrategy.emailRequested,
    budgetMode: budgetSnapshot.mode,
    expectedLlmCapThisIteration,
    targetLeadCount: state.requestedLeadCount
  });
  const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
    {
      apiKey: options.openAiApiKey,
      schemaName: "lead_agent_plan",
      jsonSchema: PLANNER_OUTPUT_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content: buildLeadPlannerSystemPrompt()
        },
          {
            role: "user",
            content: JSON.stringify({
              request: options.message,
              canonicalLeadBrief: formatLeadExecutionBriefForPrompt(options.leadExecutionBrief),
              iteration,
              budget: budgetSnapshot,
              leadDeficit,
            deficitStrategy,
            yieldSignal,
            expectedCapThisIteration: expectedLlmCapThisIteration,
            emailStrategyHint,
            leadState: {
              targetLeadCount: state.requestedLeadCount,
              currentLeadCount: state.leads.length,
              artifactCount: state.artifacts.length,
              fetchedPagesCount: state.fetchedPages.length,
              shortlistedUrlCount: state.shortlistedUrls?.length ?? 0
            },
            tools: availableTools,
            recentObservations: lastObservations,
            aggregateFailures,
            failureCodeSummary,
            reflectionHints,
            pastActionsSummary,
            recentPerformanceSummary,
            recommendedAtomicNextAction
          })
        }
      ]
    },
    PlannerOutputSchema
  );

  if (!diagnostic.result) {
    return {
      ...fallbackPlan({
        iteration,
        defaults: options.defaults,
        leadCount: state.leads.length,
        targetLeadCount: state.requestedLeadCount,
        fetchedPagesCount: state.fetchedPages.length,
        shortlistedUrlsCount: state.shortlistedUrls?.length ?? 0,
        objectiveQuery,
        emailRequested: deficitStrategy.emailRequested,
        budgetMode: budgetSnapshot.mode,
        deficitStrategy,
        expectedLlmCapThisIteration,
        hasPolishTools
      }),
      plannerFailureReason: diagnostic.failureMessage,
      llmUsage: diagnostic.usage
    };
  }

  if (diagnostic.result.actionType === "stop") {
    return {
      thought: diagnostic.result.thought,
      stop: {
        reason: diagnostic.result.stopReason ?? "manual_guardrail",
        explanation: diagnostic.result.stopExplanation ?? "Planner requested stop"
      },
      usedFallback: false,
      llmUsage: diagnostic.usage
    };
  }

  const action = normalizePlannerAction(diagnostic.result, options.maxParallelTools);
  if (!action) {
    return {
      ...fallbackPlan({
        iteration,
        defaults: options.defaults,
        leadCount: state.leads.length,
        targetLeadCount: state.requestedLeadCount,
        fetchedPagesCount: state.fetchedPages.length,
        shortlistedUrlsCount: state.shortlistedUrls?.length ?? 0,
        objectiveQuery,
        emailRequested: deficitStrategy.emailRequested,
        budgetMode: budgetSnapshot.mode,
        deficitStrategy,
        expectedLlmCapThisIteration,
        hasPolishTools
      }),
      plannerFailureReason: "planner_returned_empty_action",
      llmUsage: diagnostic.usage
    };
  }

  const diagnosticGuardrail = applyDiagnosticStallGuardrail({
    action,
    observations: lastObservations,
    availableToolNames: toolNames,
    objectiveQuery
  });

  return {
    thought: diagnostic.result.thought,
    action: diagnosticGuardrail.action,
    usedFallback: false,
    plannerFailureReason: diagnosticGuardrail.adjusted ? diagnosticGuardrail.reason : undefined,
    llmUsage: diagnostic.usage
  };
}

async function recordToolCall(runStore: RunStore, runId: string, call: Omit<ToolCallRecord, "timestamp">): Promise<void> {
  await runStore.addToolCall(runId, {
    ...call,
    timestamp: nowIso()
  });
}

export async function runLeadAgenticLoop(options: LeadAgentRuntimeOptions): Promise<RunOutcome> {
  const discoveredTools = await discoverLeadAgentTools();
  const allowlist = options.toolAllowlist?.map((item) => item.trim()).filter(Boolean);
  const availableTools = applyToolAllowlist(discoveredTools, allowlist);
  if (availableTools.size === 0) {
    return {
      status: "failed",
      assistantText: "No tools are available for this agent configuration."
    };
  }
  const targetLeadCount = options.leadExecutionBrief?.requestedLeadCount ?? parseRequestedLeadCount(options.message);
  const startMs = Date.now();
  const deadlineAtMs = startMs + options.maxDurationMs;
  const initialSynthesisState: AgentSynthesisState = {
    status: "not_ready",
    summary: "No active synthesis state yet.",
    missingEvidence: [],
    readyForSynthesis: false
  };
  const state: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: targetLeadCount,
    fetchedPages: [],
    shortlistedUrls: [],
    executionBrief: options.leadExecutionBrief,
    researchSourceCards: [],
    assumptions: [],
    unresolvedItems: [],
    activeWorkItems: [],
    candidateSets: [],
    evidenceRecords: [],
    synthesisState: initialSynthesisState
  };
  const emailRequestedByUser = isEmailRequired({
    message: options.message,
    leadExecutionBrief: options.leadExecutionBrief
  });

  const addLeads: LeadAgentToolContext["addLeads"] = (incoming) => {
    let addedCount = 0;
    const map = new Map<string, (typeof incoming)[number]>();

    for (const lead of state.leads) {
      map.set(leadKey(lead), lead);
    }

    for (const lead of incoming) {
      const key = leadKey(lead);
      const current = map.get(key);
      if (!current) {
        map.set(key, lead);
        addedCount += 1;
        continue;
      }
      if (lead.confidence > current.confidence) {
        map.set(key, lead);
      }
    }

    state.leads = Array.from(map.values());
    return {
      addedCount,
      totalCount: state.leads.length
    };
  };

  const addArtifact: LeadAgentToolContext["addArtifact"] = (artifactPath) => {
    if (!state.artifacts.includes(artifactPath)) {
      state.artifacts.push(artifactPath);
    }
  };

  const setFetchedPages: LeadAgentToolContext["setFetchedPages"] = (pages) => {
    state.fetchedPages = pages;
  };

  const getFetchedPages: LeadAgentToolContext["getFetchedPages"] = () => state.fetchedPages;
  const setShortlistedUrls: LeadAgentToolContext["setShortlistedUrls"] = (urls) => {
    state.shortlistedUrls = Array.from(new Set(urls.map((item) => item.trim()).filter(Boolean)));
  };
  const getShortlistedUrls: LeadAgentToolContext["getShortlistedUrls"] = () => state.shortlistedUrls ?? [];
  const setResearchSourceCards: LeadAgentToolContext["setResearchSourceCards"] = (cards) => {
    state.researchSourceCards = cards;
  };
  const getResearchSourceCards: LeadAgentToolContext["getResearchSourceCards"] = () => state.researchSourceCards ?? [];
  const setAssumptions: LeadAgentToolContext["setAssumptions"] = (assumptions) => {
    state.assumptions = assumptions;
  };
  const getAssumptions: LeadAgentToolContext["getAssumptions"] = () => state.assumptions ?? [];
  const setUnresolvedItems: LeadAgentToolContext["setUnresolvedItems"] = (items) => {
    state.unresolvedItems = items;
  };
  const getUnresolvedItems: LeadAgentToolContext["getUnresolvedItems"] = () => state.unresolvedItems ?? [];
  const setActiveWorkItems: LeadAgentToolContext["setActiveWorkItems"] = (items) => {
    state.activeWorkItems = items;
  };
  const getActiveWorkItems: LeadAgentToolContext["getActiveWorkItems"] = () => state.activeWorkItems ?? [];
  const setCandidateSets: LeadAgentToolContext["setCandidateSets"] = (sets) => {
    state.candidateSets = sets;
  };
  const getCandidateSets: LeadAgentToolContext["getCandidateSets"] = () => state.candidateSets ?? [];
  const setEvidenceRecords: LeadAgentToolContext["setEvidenceRecords"] = (records) => {
    state.evidenceRecords = records;
  };
  const getEvidenceRecords: LeadAgentToolContext["getEvidenceRecords"] = () => state.evidenceRecords ?? [];
  const setSynthesisState: LeadAgentToolContext["setSynthesisState"] = (synthesisState) => {
    state.synthesisState = synthesisState;
  };
  const getSynthesisState: LeadAgentToolContext["getSynthesisState"] = () => state.synthesisState;

  const toolContext: LeadAgentToolContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    message: options.message,
    leadExecutionBrief: options.leadExecutionBrief,
    deadlineAtMs,
    policyMode: options.policyMode,
    projectRoot: process.cwd(),
    runStore: options.runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    openAiApiKey: options.openAiApiKey,
    defaults: options.defaults,
    leadPipelineExecutor: options.leadPipelineExecutor,
    state,
    isCancellationRequested: options.isCancellationRequested,
    addLeads,
    addArtifact,
    setFetchedPages,
    getFetchedPages,
    setShortlistedUrls,
    getShortlistedUrls,
    setResearchSourceCards,
    getResearchSourceCards,
    setAssumptions,
    getAssumptions,
    setUnresolvedItems,
    getUnresolvedItems,
    setActiveWorkItems,
    getActiveWorkItems,
    setCandidateSets,
    getCandidateSets,
    setEvidenceRecords,
    getEvidenceRecords,
    setSynthesisState,
    getSynthesisState
  };
  const plannerBudget = new LlmBudgetManager(options.plannerMaxCalls);
  const observations: LeadAgentObservation[] = [];
  const llmUsageTotals = emptyLlmUsageTotals();
  const llmCallBudget = Math.max(
    options.plannerMaxCalls + 2,
    options.maxIterations * Math.max(3, options.defaults.subReactLlmMaxCalls)
  );
  let toolCallsUsed = 0;
  let stop: { reason: AgentStopReason; explanation: string } | undefined;
  let diminishingObservedOnce = false;
  let recoveryPendingYieldAttempt = false;
  let currentBudgetMode: BudgetMode = "normal";

  const recordLlmUsage = async (args: {
    usage?: LlmUsage;
    callCountDelta?: number;
    source: string;
    iteration: number;
  }): Promise<void> => {
    const usage = args.usage;
    const callCountDelta = Math.max(0, Math.round(args.callCountDelta ?? (usage ? 1 : 0)));
    if (usage) {
      llmUsageTotals.promptTokens += usage.promptTokens;
      llmUsageTotals.completionTokens += usage.completionTokens;
      llmUsageTotals.totalTokens += usage.totalTokens;
    }
    llmUsageTotals.callCount += callCountDelta;
    if (!usage && callCountDelta === 0) {
      return;
    }

    await options.runStore.addLlmUsage(
      options.runId,
      usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      callCountDelta
    );
    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "observe",
      eventType: "llm_usage",
      payload: {
        iteration: args.iteration,
        source: args.source,
        usageDelta: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        callCountDelta,
        totals: llmUsageTotals
      },
      timestamp: nowIso()
    });
  };

  const computeBudgetSnapshot = (stage: "pre_plan" | "pre_action" | "post_action"): BudgetSnapshot => {
    const nowMs = Date.now();
    const elapsedMs = nowMs - startMs;
    const remainingMs = deadlineAtMs - nowMs;
    const rawRatioFloor = Math.min(
      clampRatio(options.maxDurationMs > 0 ? remainingMs / options.maxDurationMs : 0),
      clampRatio(options.maxToolCalls > 0 ? (options.maxToolCalls - toolCallsUsed) / options.maxToolCalls : 0),
      clampRatio(options.plannerMaxCalls > 0 ? plannerBudget.remaining / options.plannerMaxCalls : 0),
      clampRatio(llmCallBudget > 0 ? (llmCallBudget - llmUsageTotals.callCount) / llmCallBudget : 0)
    );
    const nextMode = chooseBudgetMode(currentBudgetMode, rawRatioFloor);
    const snapshot = buildBudgetSnapshot({
      mode: nextMode,
      remainingMs,
      elapsedMs,
      maxDurationMs: options.maxDurationMs,
      toolCallsUsed,
      maxToolCalls: options.maxToolCalls,
      plannerCallsUsed: plannerBudget.used,
      plannerMaxCalls: options.plannerMaxCalls,
      llmCallsUsed: llmUsageTotals.callCount,
      llmCallBudget
    });

    if (nextMode !== currentBudgetMode) {
      void options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "agent_budget_mode_changed",
        payload: {
          stage,
          from: currentBudgetMode,
          to: nextMode,
          snapshot
        },
        timestamp: nowIso()
      });
    }

    currentBudgetMode = nextMode;
    return snapshot;
  };

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "agent_loop_started",
    payload: {
      maxIterations: options.maxIterations,
      maxDurationMs: options.maxDurationMs,
      maxToolCalls: options.maxToolCalls,
      llmCallBudget,
      initialBudgetMode: currentBudgetMode,
      parentRunId: options.parentRunId ?? null,
      delegationId: options.delegationId ?? null,
      leadExecutionBrief: options.leadExecutionBrief ?? null,
      scratchpadKeys: Object.keys(options.scratchpad ?? {}).sort(),
      toolAllowlist: allowlist ?? null,
      availableToolNames: Array.from(availableTools.keys()).sort(),
      promptStack: {
        master: ALFRED_MASTER_PROMPT_VERSION,
        domain: LEAD_DOMAIN_PROMPT_VERSION,
        plannerRole: LEAD_PLANNER_ROLE_PROMPT_VERSION
      }
    },
    timestamp: nowIso()
  });

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    if (await options.isCancellationRequested()) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "cancel_acknowledged",
        payload: {
          iteration,
          stage: "pre_plan"
        },
        timestamp: nowIso()
      });
      stop = {
        reason: "manual_cancelled",
        explanation: "Run cancelled by user request."
      };
      break;
    }

    const budgetSnapshotBeforePlan = computeBudgetSnapshot("pre_plan");
    const elapsedMs = budgetSnapshotBeforePlan.elapsedMs;
    const remainingMs = budgetSnapshotBeforePlan.remainingMs;
    const adaptiveIterationCeiling = computeDynamicIterationCeiling({
      configuredMaxIterations: options.maxIterations,
      observations,
      budgetSnapshot: budgetSnapshotBeforePlan,
      requestedLeadCount: state.requestedLeadCount,
      currentLeadCount: state.leads.length,
      diminishingThreshold: options.diminishingThreshold
    });
    if (iteration > adaptiveIterationCeiling) {
      stop = {
        reason: "budget_exhausted",
        explanation: `Stopped at adaptive iteration ceiling (${adaptiveIterationCeiling}/${options.maxIterations}) to conserve budget and avoid low-yield thrash.`
      };
      break;
    }
    if (remainingMs <= 0 || elapsedMs > options.maxDurationMs) {
      stop = {
        reason: "budget_exhausted",
        explanation: `Stopped after exceeding max duration (${options.maxDurationMs}ms).`
      };
      break;
    }

    if (toolCallsUsed >= options.maxToolCalls) {
      stop = {
        reason: "budget_exhausted",
        explanation: `Stopped after reaching tool-call budget (${options.maxToolCalls}).`
      };
      break;
    }

    const expectedLlmCapForPlan = computeExpectedLlmCapForIteration({
      mode: budgetSnapshotBeforePlan.mode,
      observations,
      highYieldThreshold: Math.max(3, options.diminishingThreshold * 2)
    });
    const deficitStrategyForPlan = computeDeficitStrategy({
      requestedLeadCount: state.requestedLeadCount,
      currentLeadCount: state.leads.length,
      mode: budgetSnapshotBeforePlan.mode,
      emailRequested: emailRequestedByUser
    });
    const yieldSignalForPlan = computeYieldPerTokenSignal(observations);
    const reflectionHintsForPlan = buildReflectionHints(observations.slice(-options.observationWindow), options.diminishingThreshold);

    const plannerDecision = await decidePlannerAction(
      options,
      plannerBudget,
      Array.from(availableTools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputHint: tool.inputHint
      })),
      iteration,
      state,
      observations,
      budgetSnapshotBeforePlan,
      expectedLlmCapForPlan,
      deficitStrategyForPlan,
      yieldSignalForPlan
    );

    await recordLlmUsage({
      usage: plannerDecision.llmUsage,
      source: "planner",
      iteration
    });

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "agent_plan_created",
      payload: {
        iteration,
        thought: plannerDecision.thought,
        action: plannerDecision.action,
        stop: plannerDecision.stop,
        usedFallback: plannerDecision.usedFallback,
        plannerFailureReason: plannerDecision.plannerFailureReason,
        plannerCallsUsed: plannerBudget.used,
        plannerCallsRemaining: plannerBudget.remaining,
        adaptiveIterationCeiling,
        expectedLlmCapThisIteration: expectedLlmCapForPlan,
        deficitStrategy: deficitStrategyForPlan,
        yieldSignal: yieldSignalForPlan,
        reflectionHints: reflectionHintsForPlan,
        budgetSnapshot: budgetSnapshotBeforePlan
      },
      timestamp: nowIso()
    });

    if (plannerDecision.stop) {
      stop = plannerDecision.stop;
      break;
    }

    const initialAction = plannerDecision.action;
    if (!initialAction) {
      stop = {
        reason: "tool_blocked",
        explanation: "Planner did not provide a runnable action."
      };
      break;
    }
    const action = initialAction;

    const budgetSnapshotBeforeAction = computeBudgetSnapshot("pre_action");
    const remainingMsBeforeAction = budgetSnapshotBeforeAction.remainingMs;
    const expectedLlmCapThisIteration = computeExpectedLlmCapForIteration({
      mode: budgetSnapshotBeforeAction.mode,
      observations,
      highYieldThreshold: Math.max(3, options.diminishingThreshold * 2)
    });
    const deficitStrategy = computeDeficitStrategy({
      requestedLeadCount: state.requestedLeadCount,
      currentLeadCount: state.leads.length,
      mode: budgetSnapshotBeforeAction.mode,
      emailRequested: emailRequestedByUser
    });
    const yieldSignal = computeYieldPerTokenSignal(observations);
    const minLeadPipelineStartMs = minLeadPipelineStartMsForMode(budgetSnapshotBeforeAction.mode);
    const actionIncludesLeadPipeline =
      action.type === "single" ? action.tool === "lead_pipeline" : action.tools.some((item) => item.tool === "lead_pipeline");
    if (actionIncludesLeadPipeline && remainingMsBeforeAction < minLeadPipelineStartMs) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "budget_guardrail",
        payload: {
          iteration,
          remainingMs: remainingMsBeforeAction,
          minLeadPipelineStartMs,
          budgetMode: budgetSnapshotBeforeAction.mode,
          expectedLlmCapThisIteration,
          deficitStrategy,
          yieldSignal,
          budgetSnapshot: budgetSnapshotBeforeAction
        },
        timestamp: nowIso()
      });
      stop = {
        reason: "budget_exhausted",
        explanation: `Stopped before starting a new lead pipeline pass because remaining budget (${Math.max(
          0,
          remainingMsBeforeAction
        )}ms) was below ${budgetSnapshotBeforeAction.mode} mode threshold (${minLeadPipelineStartMs}ms).`
      };
      break;
    }

    const baseCalls = action.type === "single" ? [{ tool: action.tool, input: action.input }] : action.tools;
    const modeAdjustedCalls = baseCalls.map((call) => {
      if (call.tool !== "lead_pipeline") {
        return call;
      }
      const remainingMsForCall = Math.max(0, deadlineAtMs - Date.now());
      const withDefaults = applyLeadPipelineActionDefaults(call.input, iteration, state.requestedLeadCount, state.leads.length);
      const withSoftStop = {
        ...withDefaults,
        softStopRemainingMs: minLeadPipelineStartMsForMode(budgetSnapshotBeforeAction.mode)
      };
      return {
        ...call,
        input: applyLeadPipelineTimeBudget(
          withSoftStop,
          remainingMsForCall,
          budgetSnapshotBeforeAction.mode,
          expectedLlmCapThisIteration
        )
      };
    });
    const searchGuardrail = applySearchQueryGuardrail(modeAdjustedCalls, options.message, options.leadExecutionBrief);
    const calls = searchGuardrail.calls;
    if (searchGuardrail.adjusted) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "agent_plan_adjusted",
        payload: {
          iteration,
          reason: searchGuardrail.reason,
          originalCalls: modeAdjustedCalls,
          adjustedCalls: calls
        },
        timestamp: nowIso()
      });
    }
    if (calls.length === 0) {
      stop = {
        reason: "tool_blocked",
        explanation: "No tool calls selected for action."
      };
      break;
    }

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "tool",
      eventType: "agent_action_selected",
      payload: {
        iteration,
        actionType: action.type,
        calls,
        adaptiveIterationCeiling,
        expectedLlmCapThisIteration,
        deficitStrategy,
        yieldSignal,
        budgetSnapshot: budgetSnapshotBeforeAction
      },
      timestamp: nowIso()
    });

    const leadsBefore = state.leads.length;
    const callExecutions = calls.map(async (call) => {
      const tool = availableTools.get(call.tool);
      if (!tool) {
        const errorMessage = `Tool not found: ${call.tool}`;
        await recordToolCall(options.runStore, options.runId, {
          toolName: call.tool,
          inputRedacted: redactValue(call.input),
          outputRedacted: { error: errorMessage },
          durationMs: 0,
          status: "error"
        });
        return {
          tool: call.tool,
          status: "error",
          durationMs: 0,
          error: errorMessage
        } as ToolRunResult;
      }

      const parsedInput = tool.inputSchema.safeParse(call.input);
      if (!parsedInput.success) {
        const errorMessage = parsedInput.error.message.slice(0, 240);
        await recordToolCall(options.runStore, options.runId, {
          toolName: call.tool,
          inputRedacted: redactValue(call.input),
          outputRedacted: { error: errorMessage },
          durationMs: 0,
          status: "error"
        });
        return {
          tool: call.tool,
          status: "error",
          durationMs: 0,
          error: errorMessage
        } as ToolRunResult;
      }

      const started = Date.now();
      try {
        const output = await tool.execute(parsedInput.data, toolContext);
        const durationMs = Date.now() - started;
        await recordToolCall(options.runStore, options.runId, {
          toolName: call.tool,
          inputRedacted: redactValue(parsedInput.data),
          outputRedacted: redactValue(output),
          durationMs,
          status: "ok"
        });

        return {
          tool: call.tool,
          status: "ok",
          durationMs,
          output
        } as ToolRunResult;
      } catch (error) {
        const durationMs = Date.now() - started;
        const errorMessage = error instanceof Error ? error.message.slice(0, 240) : "Unknown tool error";
        await recordToolCall(options.runStore, options.runId, {
          toolName: call.tool,
          inputRedacted: redactValue(parsedInput.data),
          outputRedacted: { error: errorMessage },
          durationMs,
          status: "error"
        });

        return {
          tool: call.tool,
          status: "error",
          durationMs,
          error: errorMessage
        } as ToolRunResult;
      }
    });

    const results = action.type === "parallel" ? await Promise.all(callExecutions) : [await callExecutions[0]!];
    toolCallsUsed += calls.length;

    for (const result of results) {
      const usage = normalizeLlmUsage(result.output?.llmUsage);
      const callCountDelta = parseLlmUsageCallCount(result.output?.llmUsage) ?? (usage ? 1 : 0);
      await recordLlmUsage({
        usage,
        callCountDelta,
        source: `tool:${result.tool}`,
        iteration
      });
    }
    const budgetSnapshotAfterAction = computeBudgetSnapshot("post_action");

    const newLeadCount = state.leads.length - leadsBefore;
    const failedToolCount = results.filter((result) => result.status === "error").length;
    const signals = extractObservationSignals(results);
    const llmTokensUsed = results.reduce((sum, result) => {
      const usage = normalizeLlmUsage(result.output?.llmUsage);
      return sum + (usage?.totalTokens ?? 0);
    }, 0);

    const observation: LeadAgentObservation = {
      iteration,
      actionType: action.type,
      toolNames: calls.map((item) => item.tool),
      budgetMode: budgetSnapshotAfterAction.mode,
      expectedLlmCap: expectedLlmCapThisIteration,
      yieldRelevant: isYieldRelevantAction(calls),
      llmTokensUsed,
      newLeadCount,
      totalLeadCount: state.leads.length,
      failedToolCount,
      searchFailureCount: signals.searchFailureCount,
      browseFailureCount: signals.browseFailureCount,
      extractionFailureCount: signals.extractionFailureCount,
      semanticMissCount: signals.semanticMissCount,
      retrievalBlockedCount: signals.retrievalBlockedCount,
      failureCodes: signals.failureCodes,
      leadPipelineInputSummaries: calls
        .filter((item) => item.tool === "lead_pipeline")
        .map((item) => summarizeLeadPipelineInput(item.input)),
      hadLlmBudgetExhausted: signals.hadLlmBudgetExhausted,
      note: `${summarizeActionExecution(calls, results)} | ${results.map(summarizeToolResult).join(" | ")}`
    };
    observations.push(observation);

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "observe",
      eventType: "agent_action_result",
      payload: {
        iteration,
        actionType: action.type,
        newLeadCount,
        totalLeadCount: state.leads.length,
        failedToolCount,
        searchFailureCount: signals.searchFailureCount,
        browseFailureCount: signals.browseFailureCount,
        extractionFailureCount: signals.extractionFailureCount,
        semanticMissCount: signals.semanticMissCount,
        retrievalBlockedCount: signals.retrievalBlockedCount,
        failureCodes: signals.failureCodes,
        hadLlmBudgetExhausted: signals.hadLlmBudgetExhausted,
        results,
        expectedLlmCapThisIteration,
        deficitStrategy,
        yieldSignal,
        llmUsageTotals,
        budgetSnapshot: budgetSnapshotAfterAction
      },
      timestamp: nowIso()
    });

    const recoveredSearchThisIteration = results.some(
      (result) =>
        result.tool === "recover_search" &&
        result.status === "ok" &&
        result.output &&
        typeof result.output === "object" &&
        (result.output.recovery as { recovered?: unknown } | undefined)?.recovered === true
    );
    if (recoveredSearchThisIteration) {
      recoveryPendingYieldAttempt = true;
    }
    if (observation.yieldRelevant) {
      recoveryPendingYieldAttempt = false;
    }

    const actionCancelled = results.some((result) => result.output?.cancelled === true);
    if (actionCancelled || (await options.isCancellationRequested())) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "cancel_acknowledged",
        payload: {
          iteration,
          stage: actionCancelled ? "tool_execution" : "post_action"
        },
        timestamp: nowIso()
      });
      stop = {
        reason: "manual_cancelled",
        explanation: "Run cancelled by user request."
      };
      break;
    }

    const timedOutDuringAction = results.some((result) => result.output?.timedOut === true);
    if (Date.now() > deadlineAtMs || timedOutDuringAction) {
      stop = {
        reason: "budget_exhausted",
        explanation: timedOutDuringAction
          ? "Stopped after tool execution signaled deadline exhaustion."
          : `Stopped after exceeding max duration (${options.maxDurationMs}ms).`
      };
      break;
    }

    if (state.leads.length >= state.requestedLeadCount) {
      stop = {
        reason: "target_met",
        explanation: `Reached target with ${state.leads.length} leads.`
      };
      break;
    }

    if (computeDiminishingReturns(observations, options.diminishingThreshold)) {
      if (recoveryPendingYieldAttempt) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "observe",
          eventType: "agent_replan",
          payload: {
            iteration,
            reason: "post_recovery_yield_attempt_required",
            explanation: "Search recovery succeeded recently; requiring one yield attempt before allowing diminishing-return stop."
          },
          timestamp: nowIso()
        });
        continue;
      }
      if (diminishingObservedOnce) {
        stop = {
          reason: "diminishing_returns",
          explanation: `Last two iterations added fewer than ${options.diminishingThreshold} leads each.`
        };
        break;
      }

      diminishingObservedOnce = true;
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "agent_replan",
        payload: {
          iteration,
          reason: "diminishing_returns",
          explanation: "Yield is low; forcing one replan iteration before stopping."
        },
        timestamp: nowIso()
      });
    }
  }

  if (!stop) {
    stop = {
      reason: "budget_exhausted",
      explanation: `Reached iteration budget (${options.maxIterations}).`
    };
  }

  const finalBudgetSnapshot = buildBudgetSnapshot({
    mode: currentBudgetMode,
    remainingMs: deadlineAtMs - Date.now(),
    elapsedMs: Date.now() - startMs,
    maxDurationMs: options.maxDurationMs,
    toolCallsUsed,
    maxToolCalls: options.maxToolCalls,
    plannerCallsUsed: plannerBudget.used,
    plannerMaxCalls: options.plannerMaxCalls,
    llmCallsUsed: llmUsageTotals.callCount,
    llmCallBudget
  });

  let csvPath = state.artifacts.find((item) => item.endsWith("/leads.csv"));
  if (!csvPath) {
    const start = Date.now();
    csvPath = await writeLeadsCsv(options.workspaceDir, options.runId, state.leads);
    addArtifact(csvPath);
    await recordToolCall(options.runStore, options.runId, {
      toolName: "write_csv",
      inputRedacted: { candidateCount: state.leads.length },
      outputRedacted: { csvPath },
      durationMs: Date.now() - start,
      status: "ok"
    });
  }

  if (state.artifacts.length > 0) {
    await options.runStore.updateRun(options.runId, {
      artifactPaths: [...state.artifacts]
    });
  }

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "persist",
    eventType: "artifact_written",
    payload: {
      csvPath,
      candidateCount: state.leads.length,
      totalToolCalls: toolCallsUsed,
      plannerCallsUsed: plannerBudget.used,
      llmUsageTotals,
      budgetSnapshot: finalBudgetSnapshot
    },
    timestamp: nowIso()
  });

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "final",
    eventType: "agent_stop",
    payload: {
      reason: stop.reason,
      explanation: stop.explanation,
      iterationCount: observations.length,
      leadCount: state.leads.length,
      requestedLeadCount: state.requestedLeadCount,
      totalToolCalls: toolCallsUsed,
      plannerCallsUsed: plannerBudget.used,
      elapsedMs: Date.now() - startMs,
      llmUsageTotals,
      budgetSnapshot: finalBudgetSnapshot
    },
    timestamp: nowIso()
  });

  const deficitCount = Math.max(0, state.requestedLeadCount - state.leads.length);
  const emailLeadCount = state.leads.filter((lead) => Boolean(lead.email)).length;
  const emailCoverageRatio = state.leads.length > 0 ? emailLeadCount / state.leads.length : 0;
  const assistantText = buildDeterministicAssistantSummary({
    leadCount: state.leads.length,
    requestedLeadCount: state.requestedLeadCount,
    stopReason: stop.reason,
    stopExplanation: stop.explanation,
    totalToolCalls: toolCallsUsed,
    maxToolCalls: options.maxToolCalls,
    plannerCallsUsed: plannerBudget.used,
    plannerMaxCalls: options.plannerMaxCalls,
    elapsedMs: Date.now() - startMs,
    observations,
    stateLeads: state.leads,
    llmUsageTotals,
    budgetSnapshot: finalBudgetSnapshot
  });

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "final",
    eventType: "final_answer",
    payload: {
      candidateCount: state.leads.length,
      requestedLeadCount: state.requestedLeadCount,
      deficitCount,
      emailLeadCount,
      emailCoverageRatio,
      csvPath,
      stopReason: stop.reason,
      totalToolCalls: toolCallsUsed,
      plannerCallsUsed: plannerBudget.used,
      llmUsageTotals,
      budgetSnapshot: finalBudgetSnapshot
    },
    timestamp: nowIso()
  });

  return {
    status: stop.reason === "manual_cancelled" ? "cancelled" : "completed",
    assistantText,
    artifactPaths: [csvPath]
  };
}
