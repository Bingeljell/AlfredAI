import { z } from "zod";
import type { LlmUsage, LlmUsageTotals, RunOutcome, ToolCallRecord } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import { discoverLeadAgentTools } from "../agent/tools/registry.js";
import type { LeadAgentDefaults, LeadAgentState, LeadAgentToolContext } from "../agent/types.js";
import { parseRequestedLeadCount } from "../tools/lead/requestIntent.js";
import { runOpenAiStructuredChatWithDiagnostics } from "../services/openAiClient.js";
import { LlmBudgetManager } from "../tools/lead/llmBudget.js";
import type { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import { writeLeadsCsv } from "../tools/csv/writeCsv.js";
import { redactValue } from "../utils/redact.js";

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
  newLeadCount: number;
  totalLeadCount: number;
  failedToolCount: number;
  searchFailureCount: number;
  browseFailureCount: number;
  extractionFailureCount: number;
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

interface AgenticLoopOptions {
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
  applyFailureGuardrail,
  extractObservationSignals
};

export const plannerContextForTests = {
  buildPastActionsSummary
};

function summarizeToolResult(result: ToolRunResult): string {
  if (result.status === "error") {
    return `${result.tool} failed: ${result.error}`;
  }

  const output = result.output ?? {};
  if (result.tool === "recover_search") {
    const recovery = output.recovery as { recovered?: unknown; reason?: unknown } | undefined;
    const recovered = recovery?.recovered === true;
    const reason = typeof recovery?.reason === "string" ? recovery.reason : "unknown";
    return `recover_search ${recovered ? "recovered" : "not_recovered"} (${reason})`;
  }

  if (result.tool === "search_status") {
    const primaryHealthy = output.primaryHealthy === true ? "healthy" : "unhealthy";
    const fallbackHealthy = output.fallbackHealthy === true ? "healthy" : "unhealthy";
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

  return `${result.tool} ok`;
}

function summarizeLeadPipelineInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const maxPages = typeof input.maxPages === "number" ? Math.round(input.maxPages) : undefined;
  const llmMaxCalls = typeof input.llmMaxCalls === "number" ? Math.round(input.llmMaxCalls) : undefined;
  const extractionBatchSize = typeof input.extractionBatchSize === "number" ? Math.round(input.extractionBatchSize) : undefined;
  const browseConcurrency = typeof input.browseConcurrency === "number" ? Math.round(input.browseConcurrency) : undefined;
  const minConfidence = typeof input.minConfidence === "number" ? Number(input.minConfidence.toFixed(2)) : undefined;

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

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractObservationSignals(results: ToolRunResult[]): {
  searchFailureCount: number;
  browseFailureCount: number;
  extractionFailureCount: number;
  hadLlmBudgetExhausted: boolean;
} {
  let searchFailureCount = 0;
  let browseFailureCount = 0;
  let extractionFailureCount = 0;
  let hadLlmBudgetExhausted = false;

  for (const result of results) {
    const output = result.output ?? {};
    searchFailureCount += readNumber(output.searchFailureCount);
    browseFailureCount += readNumber(output.browseFailureCount);
    extractionFailureCount += readNumber(output.extractionFailureCount);

    const extractionSamples = Array.isArray(output.extractionFailureSamples) ? output.extractionFailureSamples : [];
    if (
      extractionSamples.some((sample) => {
        const reason = typeof (sample as { reason?: unknown }).reason === "string" ? (sample as { reason: string }).reason : "";
        return reason.includes("llm_budget_exhausted");
      })
    ) {
      hadLlmBudgetExhausted = true;
    }
  }

  return {
    searchFailureCount,
    browseFailureCount,
    extractionFailureCount,
    hadLlmBudgetExhausted
  };
}

function applyFailureGuardrail(action: AgentAction, observations: LeadAgentObservation[]): {
  action: AgentAction;
  adjusted: boolean;
  reason?: string;
} {
  const lastObservation = observations.at(-1);
  if (!lastObservation) {
    return { action, adjusted: false };
  }

  const hasLeadPipelineCall =
    action.type === "single"
      ? action.tool === "lead_pipeline"
      : action.tools.some((item) => item.tool === "lead_pipeline");

  if (!hasLeadPipelineCall || lastObservation.searchFailureCount === 0) {
    return { action, adjusted: false };
  }

  const alreadyCheckedSearch =
    lastObservation.toolNames.includes("search_status") || lastObservation.toolNames.includes("recover_search");
  if (alreadyCheckedSearch) {
    return { action, adjusted: false };
  }

  return {
    action: {
      type: "single",
      tool: "search_status",
      input: {}
    },
    adjusted: true,
    reason: "search_failures_detected_in_previous_iteration"
  };
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
}): string {
  const deficitCount = Math.max(0, args.requestedLeadCount - args.leadCount);
  const emailLeadCount = args.stateLeads.filter((lead) => Boolean(lead.email)).length;
  const emailCoverageRatio = args.leadCount > 0 ? emailLeadCount / args.leadCount : 0;

  let searchFailureCount = 0;
  let browseFailureCount = 0;
  let extractionFailureCount = 0;
  for (const observation of args.observations) {
    searchFailureCount += observation.searchFailureCount;
    browseFailureCount += observation.browseFailureCount;
    extractionFailureCount += observation.extractionFailureCount;
  }

  return [
    `Leads collected: ${args.leadCount}/${args.requestedLeadCount} (deficit ${deficitCount}).`,
    `Email coverage: ${emailLeadCount}/${args.leadCount} (${(emailCoverageRatio * 100).toFixed(1)}%).`,
    `Observed failures: search ${searchFailureCount}, browse ${browseFailureCount}, extraction ${extractionFailureCount}.`,
    `LLM usage: ${args.llmUsageTotals.totalTokens} total tokens (${args.llmUsageTotals.promptTokens} prompt, ${args.llmUsageTotals.completionTokens} completion) across ${args.llmUsageTotals.callCount} calls.`,
    `Stop: ${args.stopReason} (${args.stopExplanation}) | Tool calls ${args.totalToolCalls}/${args.maxToolCalls}, planner calls ${args.plannerCallsUsed}/${args.plannerMaxCalls}, elapsed ${Math.round(args.elapsedMs / 1000)}s.`
  ].join("\n");
}

function computeDiminishingReturns(history: LeadAgentObservation[], threshold: number): boolean {
  if (history.length < 2) {
    return false;
  }

  const lastTwo = history.slice(-2);
  return lastTwo.every((item) => item.newLeadCount < threshold);
}

interface LeadPipelineModeBounds {
  maxPages: number;
  llmMaxCalls: number;
  browseConcurrency: number;
  extractionBatchSize: number;
}

const MIN_LEAD_PIPELINE_START_MS = 20_000;

function leadPipelineBoundsForMode(mode: BudgetMode): LeadPipelineModeBounds {
  if (mode === "emergency") {
    return {
      maxPages: 5,
      llmMaxCalls: 3,
      browseConcurrency: 2,
      extractionBatchSize: 2
    };
  }
  if (mode === "conserve") {
    return {
      maxPages: 12,
      llmMaxCalls: 6,
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
  mode: BudgetMode
): Record<string, unknown> {
  const adjusted = { ...input };
  const modeBounds = leadPipelineBoundsForMode(mode);

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

  clampByMode();

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
  return adjusted;
}

export const budgetGuardrailsForTests = {
  applyLeadPipelineTimeBudget,
  MIN_LEAD_PIPELINE_START_MS,
  leadPipelineBoundsForMode
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

function fallbackPlan(iteration: number, defaults: LeadAgentDefaults, leadCount: number, targetLeadCount: number): PlannerDecision {
  if (leadCount >= targetLeadCount) {
    return {
      thought: "Target reached.",
      stop: { reason: "target_met", explanation: "Collected enough leads to satisfy requested target." },
      usedFallback: true
    };
  }

  if (iteration === 1) {
    return {
      thought: "Run baseline lead pipeline first.",
      action: {
        type: "single",
        tool: "lead_pipeline",
        input: { minConfidence: determineAdaptiveMinConfidence(iteration, targetLeadCount, leadCount) }
      },
      usedFallback: true
    };
  }

  if (iteration === 2) {
    return {
      thought: "Increase crawl depth to improve recall.",
      action: {
        type: "single",
        tool: "lead_pipeline",
        input: {
          maxPages: Math.min(20, defaults.subReactMaxPages + 5),
          minConfidence: determineAdaptiveMinConfidence(iteration, targetLeadCount, leadCount)
        }
      },
      usedFallback: true
    };
  }

  if (iteration === 3) {
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
  options: AgenticLoopOptions,
  plannerBudget: LlmBudgetManager,
  availableTools: Array<{ name: string; description: string; inputHint: string }>,
  iteration: number,
  state: LeadAgentState,
  observations: LeadAgentObservation[],
  budgetSnapshot: BudgetSnapshot
): Promise<PlannerDecision> {
  if (!options.openAiApiKey || !plannerBudget.consume()) {
    return fallbackPlan(iteration, options.defaults, state.leads.length, state.requestedLeadCount);
  }

  const lastObservations = observations.slice(-options.observationWindow);
  const pastActionsSummary = buildPastActionsSummary(lastObservations);
  const aggregateFailures = lastObservations.reduce(
    (acc, item) => {
      acc.failedToolCount += item.failedToolCount;
      acc.searchFailureCount += item.searchFailureCount;
      acc.browseFailureCount += item.browseFailureCount;
      acc.extractionFailureCount += item.extractionFailureCount;
      acc.hadLlmBudgetExhausted = acc.hadLlmBudgetExhausted || item.hadLlmBudgetExhausted;
      return acc;
    },
    {
      failedToolCount: 0,
      searchFailureCount: 0,
      browseFailureCount: 0,
      extractionFailureCount: 0,
      hadLlmBudgetExhausted: false
    }
  );
  const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
    {
      apiKey: options.openAiApiKey,
      schemaName: "lead_agent_plan",
      jsonSchema: PLANNER_OUTPUT_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content:
            "You are Alfred's lead-generation planner. Decide the next best tool action (single or parallel) to reach lead targets. Prefer actions that improve yield and avoid unnecessary calls. You will receive structured failure signals per iteration (searchFailureCount, browseFailureCount, extractionFailureCount, hadLlmBudgetExhausted) and a capped pastActionsSummary. React to failures explicitly: if searchFailureCount > 0, prioritize search_status before retrying lead_pipeline, and use recover_search when recovery is supported. If hadLlmBudgetExhausted is true, reduce llmMaxCalls/extraction scope on the next lead_pipeline action. If failedToolCount > 0 across recent observations, your thought must acknowledge that failure signal before choosing the next action. Budget mode is dynamic: when budgetMode is conserve or emergency, prioritize high-yield/low-cost actions (search_status/search) before deep full-pipeline runs; use smaller lead_pipeline inputs and avoid expensive retries unless signal quality is high. Use pastActionsSummary to avoid repeating low-yield actions with identical inputs. Treat service recovery as agentic work you should attempt before stopping. Respect tool constraints: lead_pipeline.maxPages <= 25, browseConcurrency <= 6, extractionBatchSize <= 6, llmMaxCalls <= 20, minConfidence between 0 and 1. For action inputs, always return inputJson as a valid JSON object string (for example: \"{}\" or \"{\\\"maxPages\\\":20}\")."
        },
        {
          role: "user",
          content: JSON.stringify({
            request: options.message,
            iteration,
            budget: budgetSnapshot,
            leadState: {
              targetLeadCount: state.requestedLeadCount,
              currentLeadCount: state.leads.length,
              artifactCount: state.artifacts.length
            },
            tools: availableTools,
            recentObservations: lastObservations,
            aggregateFailures,
            pastActionsSummary
          })
        }
      ]
    },
    PlannerOutputSchema
  );

  if (!diagnostic.result) {
    return {
      ...fallbackPlan(iteration, options.defaults, state.leads.length, state.requestedLeadCount),
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
      ...fallbackPlan(iteration, options.defaults, state.leads.length, state.requestedLeadCount),
      plannerFailureReason: "planner_returned_empty_action",
      llmUsage: diagnostic.usage
    };
  }

  return {
    thought: diagnostic.result.thought,
    action,
    usedFallback: false,
    llmUsage: diagnostic.usage
  };
}

async function recordToolCall(runStore: RunStore, runId: string, call: Omit<ToolCallRecord, "timestamp">): Promise<void> {
  await runStore.addToolCall(runId, {
    ...call,
    timestamp: nowIso()
  });
}

export async function runLeadAgenticLoop(options: AgenticLoopOptions): Promise<RunOutcome> {
  const availableTools = await discoverLeadAgentTools();
  const targetLeadCount = parseRequestedLeadCount(options.message);
  const startMs = Date.now();
  const deadlineAtMs = startMs + options.maxDurationMs;
  const state: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: targetLeadCount
  };

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

  const toolContext: LeadAgentToolContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    message: options.message,
    deadlineAtMs,
    runStore: options.runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    openAiApiKey: options.openAiApiKey,
    defaults: options.defaults,
    leadPipelineExecutor: options.leadPipelineExecutor,
    state,
    isCancellationRequested: options.isCancellationRequested,
    addLeads,
    addArtifact
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
      initialBudgetMode: currentBudgetMode
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
      budgetSnapshotBeforePlan
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

    const guardedPlan = applyFailureGuardrail(initialAction, observations);
    const action = guardedPlan.action;

    if (guardedPlan.adjusted) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "agent_plan_adjusted",
        payload: {
          iteration,
          reason: guardedPlan.reason,
          originalAction: initialAction,
          adjustedAction: action
        },
        timestamp: nowIso()
      });
    }

    const budgetSnapshotBeforeAction = computeBudgetSnapshot("pre_action");
    const remainingMsBeforeAction = budgetSnapshotBeforeAction.remainingMs;
    const actionIncludesLeadPipeline =
      action.type === "single" ? action.tool === "lead_pipeline" : action.tools.some((item) => item.tool === "lead_pipeline");
    if (actionIncludesLeadPipeline && remainingMsBeforeAction < MIN_LEAD_PIPELINE_START_MS) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "budget_guardrail",
        payload: {
          iteration,
          remainingMs: remainingMsBeforeAction,
          minLeadPipelineStartMs: MIN_LEAD_PIPELINE_START_MS,
          budgetSnapshot: budgetSnapshotBeforeAction
        },
        timestamp: nowIso()
      });
      stop = {
        reason: "budget_exhausted",
        explanation: `Stopped before starting a new lead pipeline pass because remaining budget (${Math.max(
          0,
          remainingMsBeforeAction
        )}ms) was below safe threshold (${MIN_LEAD_PIPELINE_START_MS}ms).`
      };
      break;
    }

    const baseCalls = action.type === "single" ? [{ tool: action.tool, input: action.input }] : action.tools;
    const calls = baseCalls.map((call) => {
      if (call.tool !== "lead_pipeline") {
        return call;
      }
      const remainingMsForCall = Math.max(0, deadlineAtMs - Date.now());
      const withDefaults = applyLeadPipelineActionDefaults(call.input, iteration, state.requestedLeadCount, state.leads.length);
      return {
        ...call,
        input: applyLeadPipelineTimeBudget(withDefaults, remainingMsForCall, budgetSnapshotBeforeAction.mode)
      };
    });
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

    const observation: LeadAgentObservation = {
      iteration,
      actionType: action.type,
      toolNames: calls.map((item) => item.tool),
      newLeadCount,
      totalLeadCount: state.leads.length,
      failedToolCount,
      searchFailureCount: signals.searchFailureCount,
      browseFailureCount: signals.browseFailureCount,
      extractionFailureCount: signals.extractionFailureCount,
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
        hadLlmBudgetExhausted: signals.hadLlmBudgetExhausted,
        results,
        llmUsageTotals,
        budgetSnapshot: budgetSnapshotAfterAction
      },
      timestamp: nowIso()
    });

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
      llmUsageTotals
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
      llmUsageTotals
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
    llmUsageTotals
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
      llmUsageTotals
    },
    timestamp: nowIso()
  });

  return {
    status: stop.reason === "manual_cancelled" ? "cancelled" : "completed",
    assistantText,
    artifactPaths: [csvPath]
  };
}
