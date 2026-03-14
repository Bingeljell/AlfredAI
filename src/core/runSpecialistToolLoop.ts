import { z } from "zod";
import type { RunOutcome } from "../types.js";
import * as openAiClient from "../services/openAiClient.js";
import { composeSystemPrompt } from "../prompts/composePrompt.js";
import { ALFRED_MASTER_PROMPT_VERSION, ALFRED_MASTER_SYSTEM_PROMPT } from "../prompts/master/alfred.system.js";
import type { AgentSkillRunOptions } from "../agent/skills/types.js";
import type { LeadAgentState, LeadAgentToolContext, ResearchSourceCard } from "../agent/types.js";
import {
  applyToolAllowlist,
  discoverLeadAgentTools,
  executeToolWithEnvelope,
  type ToolExecutionEnvelope
} from "../agent/tools/registry.js";
import { classifyStructuredFailure, computeRetryDelayMs, sleep } from "./reliability.js";
import { getToolInputContract } from "../agent/toolContracts.js";

interface SpecialistToolLoopOptions extends AgentSkillRunOptions {
  skillName: string;
  skillDescription: string;
  skillSystemPrompt: string;
  toolAllowlist: string[];
  structuredChatRunner?: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
}

interface SpecialistPlannerOutput {
  thought: string;
  actionType: "single" | "parallel" | "respond";
  singleTool: string | null;
  singleInputJson: string | null;
  parallelActions: Array<{ tool: string; inputJson: string }> | null;
  responseText: string | null;
}

type ToolExecutionResult = ToolExecutionEnvelope & { summary: string };

interface SpecialistTaskContract {
  requiredDeliverable: string;
  requiresDraft: boolean;
  requiresCitations: boolean;
  minimumCitationCount: number;
  doneCriteria: string[];
}

type SpecialistPhaseTransitionHint =
  | "discovery_complete_fetch_pending"
  | "fetch_complete_synthesis_pending"
  | "synthesis_complete_persist_pending"
  | null;

type SpecialistPhase = "discovery" | "fetch" | "synthesis" | "persist" | "complete";

interface SearchRetryProfile {
  mode: "stable" | "flaky" | "degraded";
  timeoutCount: number;
  recommendation: string;
  maxParallelSearchActions: number;
}

interface SpecialistProgressState {
  successfulToolCalls: number;
  sourceUrls: Set<string>;
  fetchedPageCount: number;
  draftWordCount: number;
  citationCount: number;
  searchTimeoutCount: number;
  errorSamples: string[];
}

interface ProgressSnapshot {
  sourceUrlCount: number;
  fetchedPageCount: number;
  draftWordCount: number;
  artifactCount: number;
}

const SPECIALIST_PLANNER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 600 },
    actionType: { type: "string", enum: ["single", "parallel", "respond"] },
    singleTool: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    singleInputJson: { anyOf: [{ type: "string", minLength: 2, maxLength: 2400 }, { type: "null" }] },
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
              inputJson: { type: "string", minLength: 2, maxLength: 2400 }
            },
            required: ["tool", "inputJson"]
          }
        },
        { type: "null" }
      ]
    },
    responseText: { anyOf: [{ type: "string", minLength: 1, maxLength: 5000 }, { type: "null" }] }
  },
  required: ["thought", "actionType", "singleTool", "singleInputJson", "parallelActions", "responseText"]
} as const;

const SpecialistPlannerOutputSchema: z.ZodType<SpecialistPlannerOutput> = z.object({
  thought: z.string().min(1).max(600),
  actionType: z.enum(["single", "parallel", "respond"]),
  singleTool: z.string().min(1).max(80).nullable(),
  singleInputJson: z.string().min(2).max(2400).nullable(),
  parallelActions: z
    .array(
      z.object({
        tool: z.string().min(1).max(80),
        inputJson: z.string().min(2).max(2400)
      })
    )
    .max(4)
    .nullable(),
  responseText: z.string().min(1).max(5000).nullable()
});

function nowIso(): string {
  return new Date().toISOString();
}

const SEARCH_FAMILY_TOOLS = new Set(["search", "lead_search_shortlist", "search_status"]);
const DOWNSTREAM_PROGRESS_TOOLS = new Set(["web_fetch", "lead_extract", "writer_agent", "file_write", "write_csv"]);
const DISCOVERY_PHASE_LOCK_MIN_SOURCE_URLS = 20;
const DIAGNOSTIC_TOOLS = new Set(["search_status", "run_diagnostics"]);

function isSchemaInputError(error: string | null): boolean {
  if (!error) {
    return false;
  }
  const normalized = error.toLowerCase();
  return normalized.includes("tool_schema_validation_failed") || normalized.includes("invalid_input_json");
}

function safeParseObject(inputJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function firstString(values: unknown): string | null {
  if (!Array.isArray(values)) {
    return null;
  }
  for (const value of values) {
    const parsed = asString(value);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function deriveObjectiveQuery(objective: string): string {
  return objective
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function extractOutputPathFromObjective(objective: string): string | null {
  const match = objective.match(/\bworkspace\/[^\s"'`]+/i);
  return match?.[0]?.trim() ?? null;
}

function normalizeCandidateUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function selectFetchUrlsForHandoff(sourceUrls: Set<string>, maxUrls = 12): string[] {
  const normalized = Array.from(sourceUrls)
    .map((item) => normalizeCandidateUrl(item))
    .filter((item): item is string => Boolean(item));
  return normalized.slice(0, Math.max(1, maxUrls));
}

function normalizeActionInputForSchemaRecovery(tool: string, inputJson: string, objective: string): string {
  const parsed = safeParseObject(inputJson) ?? {};
  if (tool === "search" || tool === "lead_search_shortlist") {
    const query =
      asString(parsed.query)
      ?? firstString(parsed.queries)
      ?? asString(parsed.prompt)
      ?? asString(parsed.instruction)
      ?? deriveObjectiveQuery(objective);
    const maxResults =
      asInteger(parsed.maxResults) ?? asInteger(parsed.numResults) ?? asInteger(parsed.top_k) ?? 10;
    const normalized: Record<string, unknown> = {
      query,
      maxResults
    };
    if (tool === "lead_search_shortlist") {
      normalized.maxUrls = asInteger(parsed.maxUrls) ?? 12;
    }
    return JSON.stringify(normalized);
  }
  if (tool === "writer_agent") {
    const instruction =
      asString(parsed.instruction)
      ?? asString(parsed.brief)
      ?? asString(parsed.prompt)
      ?? deriveObjectiveQuery(objective);
    const outputPath = asString(parsed.outputPath) ?? extractOutputPathFromObjective(objective);
    const normalized: Record<string, unknown> = {
      instruction,
      maxWords: asInteger(parsed.maxWords) ?? 950,
      format: asString(parsed.format) ?? "blog_post"
    };
    if (outputPath) {
      normalized.outputPath = outputPath;
    }
    return JSON.stringify(normalized);
  }
  return inputJson;
}

export function shouldForcePhaseTransition(args: {
  contract: SpecialistTaskContract;
  progress: SpecialistProgressState;
  actions: Array<{ tool: string; inputJson: string }>;
  availableToolNames: Set<string>;
  objective: string;
}): { forced: Array<{ tool: string; inputJson: string }> | null; reason: string | null } {
  const isSearchOnly = args.actions.length > 0 && args.actions.every((item) => SEARCH_FAMILY_TOOLS.has(item.tool));
  if (!isSearchOnly) {
    return { forced: null, reason: null };
  }

  if (
    (args.contract.requiresDraft || args.contract.requiresCitations) &&
    args.progress.sourceUrls.size >= DISCOVERY_PHASE_LOCK_MIN_SOURCE_URLS &&
    args.progress.fetchedPageCount === 0 &&
    args.availableToolNames.has("web_fetch")
  ) {
    const fetchUrls = selectFetchUrlsForHandoff(args.progress.sourceUrls, 12);
    return {
      forced: [
        {
          tool: "web_fetch",
          inputJson: fetchUrls.length > 0
            ? JSON.stringify({
                urls: fetchUrls,
                maxPages: Math.min(10, fetchUrls.length),
                browseConcurrency: 3
              })
            : JSON.stringify({
                query: deriveObjectiveQuery(args.objective),
                maxPages: 10,
                browseConcurrency: 3
              })
        }
      ],
      reason: "phase_lock_forced_transition_discovery_to_fetch"
    };
  }

  if (
    args.contract.requiresDraft &&
    args.progress.fetchedPageCount >= 4 &&
    args.progress.draftWordCount === 0 &&
    args.availableToolNames.has("writer_agent")
  ) {
    return {
      forced: [
        {
          tool: "writer_agent",
          inputJson: JSON.stringify({
            instruction: "Draft the requested response from fetched sources and include citation URLs.",
            maxWords: 950,
            format: "blog_post"
          })
        }
      ],
      reason: "phase_lock_forced_transition_fetch_to_synthesis"
    };
  }

  return { forced: null, reason: null };
}

function deriveSpecialistPhase(
  contract: SpecialistTaskContract,
  progress: SpecialistProgressState,
  artifactCount: number
): SpecialistPhase {
  if (!(contract.requiresDraft || contract.requiresCitations)) {
    return progress.successfulToolCalls > 0 ? "complete" : "discovery";
  }
  if (progress.sourceUrls.size === 0) {
    return "discovery";
  }
  if (progress.fetchedPageCount === 0) {
    return "fetch";
  }
  if (progress.draftWordCount === 0) {
    return "synthesis";
  }
  if (artifactCount === 0) {
    return "persist";
  }
  return "complete";
}

function expectedPhaseToolFamily(phase: SpecialistPhase, skillName: string): string {
  switch (phase) {
    case "discovery":
      return "search/shortlist";
    case "fetch":
      return "web_fetch";
    case "synthesis":
      return skillName === "research_agent" ? "writer_agent" : "writer_agent/lead_extract";
    case "persist":
      return skillName === "research_agent"
        ? "writer_agent(outputPath)/file_write"
        : "file_write/write_csv/writer_agent(outputPath)";
    case "complete":
      return "respond";
    default:
      return "tool";
  }
}

function captureProgressSnapshot(progress: SpecialistProgressState, artifactCount: number): ProgressSnapshot {
  return {
    sourceUrlCount: progress.sourceUrls.size,
    fetchedPageCount: progress.fetchedPageCount,
    draftWordCount: progress.draftWordCount,
    artifactCount
  };
}

function computeIterationValueDelta(before: ProgressSnapshot, after: ProgressSnapshot): number {
  const sourceDelta = Math.max(0, after.sourceUrlCount - before.sourceUrlCount);
  const fetchDelta = Math.max(0, after.fetchedPageCount - before.fetchedPageCount);
  const draftDelta = Math.max(0, after.draftWordCount - before.draftWordCount);
  const artifactDelta = Math.max(0, after.artifactCount - before.artifactCount);
  return sourceDelta * 0.15 + fetchDelta * 2.0 + draftDelta / 220 + artifactDelta * 4.0;
}

function shouldApplyDiagnosticThrashGuard(
  actions: Array<{ tool: string; inputJson: string }>,
  consecutiveHealthySearchStatusChecks: number
): boolean {
  if (consecutiveHealthySearchStatusChecks < 1) {
    return false;
  }
  return actions.length > 0 && actions.every((item) => DIAGNOSTIC_TOOLS.has(item.tool));
}

function defaultToolInputJson(tool: string, objective: string): string | null {
  const objectiveQuery = deriveObjectiveQuery(objective);
  switch (tool) {
    case "search_status":
    case "run_diagnostics":
      return "{}";
    case "search":
      return JSON.stringify({ query: objectiveQuery, maxResults: 10 });
    case "lead_search_shortlist":
      return JSON.stringify({ query: objectiveQuery, maxResults: 10, maxUrls: 12 });
    case "web_fetch":
      return JSON.stringify({ query: objectiveQuery, maxPages: 10, browseConcurrency: 3 });
    case "writer_agent":
      return JSON.stringify({ instruction: objective.slice(0, 1200), maxWords: 950, format: "blog_post" });
    default:
      return null;
  }
}

function buildSpecialistPlannerSystemPrompt(options: Pick<SpecialistToolLoopOptions, "skillSystemPrompt">): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Specialist Role",
      content: options.skillSystemPrompt
    },
    {
      label: "ReAct Directives",
      content:
        "Use iterative reasoning: choose tools, observe output, and replan. Prefer the smallest set of high-yield actions. Respect the specialist objective contract you receive in planner input: do not return actionType=respond until required deliverable criteria are satisfied, unless you explicitly report a failure summary with concrete evidence. Maintain phase progression when drafting tasks are requested: discovery -> fetch -> synthesis -> persist. If discovery has URLs but fetch is still zero, prioritize downstream transition over repeating search-only cycles. Each tool includes an `inputContract` in planner context: obey required fields and bounds strictly. For tool actions, always provide valid JSON object input."
    }
  ]);
}

function truncateForPrompt(value: unknown, maxLength = 2200): string {
  const serialized =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, nestedValue) => {
          if (typeof nestedValue === "string" && nestedValue.length > 300) {
            return `${nestedValue.slice(0, 300)}...`;
          }
          return nestedValue;
        });
  return serialized.slice(0, maxLength);
}

function extractArtifactPaths(tool: string, output: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (tool === "write_csv") {
    const csvPath = output.csvPath;
    if (typeof csvPath === "string" && csvPath.trim()) {
      paths.push(csvPath.trim());
    }
  }
  if (tool === "file_write" || tool === "file_edit") {
    const filePath = output.path;
    if (typeof filePath === "string" && filePath.trim()) {
      paths.push(filePath.trim());
    }
  }
  if (tool === "writer_agent") {
    const outputPath = output.outputPath;
    if (typeof outputPath === "string" && outputPath.trim()) {
      paths.push(outputPath.trim());
    }
  }
  return paths;
}

function formatObservationSummary(results: ToolExecutionResult[]): string {
  return results
    .map((result) => {
      if (result.status === "ok") {
        return `${result.tool}:ok(${result.durationMs}ms)`;
      }
      return `${result.tool}:error(${result.error ?? "execution_failed"})`;
    })
    .join(", ");
}

function buildFallbackAssistantText(skillName: string, observations: Array<{ iteration: number; summary: string }>): string {
  if (observations.length === 0) {
    return `${skillName} stopped before producing a conclusive result.`;
  }
  const recent = observations.slice(-4).map((item) => `iter ${item.iteration}: ${item.summary}`).join(" | ");
  return `${skillName} stopped by runtime guardrails. Recent observations: ${recent}`;
}

function buildSpecialistResultAssistantText(
  skillName: string,
  result: Pick<ToolExecutionResult, "tool" | "result" | "durationMs">
): string {
  const payload = result.result ?? {};
  if (result.tool === "process_list") {
    const processes = Array.isArray(payload.processes) ? payload.processes : [];
    const rendered = processes
      .slice(0, 20)
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const record = item as Record<string, unknown>;
        const pid = typeof record.pid === "number" ? record.pid : "unknown";
        const command = typeof record.command === "string" ? record.command : "";
        const args = typeof record.args === "string" ? record.args : "";
        return `- pid=${pid} command=${command} args=${args}`.slice(0, 240);
      })
      .filter((line): line is string => Boolean(line));
    const totalMatched = typeof payload.totalMatched === "number" ? payload.totalMatched : processes.length;
    return [
      `${skillName} completed process inspection via process_list (${result.durationMs}ms).`,
      `Matched processes: ${totalMatched}.`,
      rendered.length > 0 ? rendered.join("\n") : "No process rows were returned."
    ].join("\n");
  }

  if (result.tool === "file_read") {
    const path = typeof payload.path === "string" ? payload.path : "unknown";
    const truncated = payload.truncatedByChars === true;
    const content = typeof payload.content === "string" ? payload.content : "";
    return [
      `${skillName} read file content from ${path} (${result.durationMs}ms).`,
      truncated ? "Note: content is truncated by char limit." : "Content was read within current bounds.",
      content.slice(0, 1800)
    ].join("\n");
  }

  return `${skillName} latest successful tool result (${result.tool}): ${truncateForPrompt(payload, 1800)}`;
}

function buildSpecialistTaskContract(options: Pick<SpecialistToolLoopOptions, "skillName" | "message">): SpecialistTaskContract {
  const normalized = options.message.toLowerCase();
  const isResearchSkill = options.skillName === "research_agent";
  const requiresDraft = isResearchSkill && /\b(blog|post|article|draft|write)\b/.test(normalized);
  const requiresCitations = isResearchSkill && /\b(cite|citation|sources?)\b/.test(normalized);
  const minimumCitationCount = requiresCitations ? 2 : 0;

  if (isResearchSkill) {
    return {
      requiredDeliverable: requiresDraft
        ? "Produce a complete research-backed draft response."
        : "Produce a concise research synthesis response.",
      requiresDraft,
      requiresCitations,
      minimumCitationCount,
      doneCriteria: [
        "Gather source evidence from search/fetch outputs.",
        requiresDraft ? "Return full draft text (not only status)." : "Return synthesized findings.",
        requiresCitations ? `Include at least ${minimumCitationCount} citation links.` : "Citations preferred when available."
      ]
    };
  }

  return {
    requiredDeliverable: "Return a complete specialist response for the current objective.",
    requiresDraft: false,
    requiresCitations: false,
    minimumCitationCount: 0,
    doneCriteria: ["Return a complete response for the delegated objective."]
  };
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  return Array.from(new Set(matches.map((item) => item.trim())));
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function createSpecialistProgressState(): SpecialistProgressState {
  return {
    successfulToolCalls: 0,
    sourceUrls: new Set<string>(),
    fetchedPageCount: 0,
    draftWordCount: 0,
    citationCount: 0,
    searchTimeoutCount: 0,
    errorSamples: []
  };
}

function normalizeSourceDate(value: string): string | null {
  const isoMatch = value.match(/\b(20\d{2})[-/](\d{2})[-/](\d{2})\b/);
  if (!isoMatch) {
    return null;
  }
  const year = isoMatch[1];
  const month = isoMatch[2];
  const day = isoMatch[3];
  return `${year}-${month}-${day}`;
}

function toSourceClaim(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, maxLength);
}

function extractQuoteSnippet(text: string): string | null {
  const quoted = text.match(/"([^"]{20,260})"/)?.[1];
  if (quoted) {
    return toSourceClaim(quoted, 220);
  }
  return null;
}

function mergeResearchSourceCards(existing: ResearchSourceCard[], incoming: ResearchSourceCard[]): ResearchSourceCard[] {
  const next = new Map<string, ResearchSourceCard>();
  for (const card of [...existing, ...incoming]) {
    if (!card.url) {
      continue;
    }
    const prev = next.get(card.url);
    if (!prev) {
      next.set(card.url, card);
      continue;
    }
    const merged: ResearchSourceCard = {
      ...prev,
      title: prev.title ?? card.title,
      date: prev.date ?? card.date,
      claim: prev.claim.length >= card.claim.length ? prev.claim : card.claim,
      quote: prev.quote ?? card.quote
    };
    next.set(card.url, merged);
  }
  return Array.from(next.values()).slice(-120);
}

function deriveSourceCardsFromExecution(
  execution: ToolExecutionResult,
  context: LeadAgentToolContext
): ResearchSourceCard[] {
  if (execution.status !== "ok") {
    return [];
  }
  const payload = execution.result ?? {};
  const cards: ResearchSourceCard[] = [];
  if (execution.tool === "search") {
    const topResults = Array.isArray(payload.topResults) ? payload.topResults : [];
    for (const result of topResults) {
      if (!result || typeof result !== "object") {
        continue;
      }
      const record = result as Record<string, unknown>;
      const url = asString(record.url);
      const title = asString(record.title);
      const snippet = asString(record.snippet) ?? "";
      if (!url || !snippet) {
        continue;
      }
      cards.push({
        url,
        title,
        date: normalizeSourceDate(`${url} ${title ?? ""} ${snippet}`),
        claim: toSourceClaim(snippet),
        quote: null,
        sourceTool: execution.tool
      });
    }
    return cards;
  }

  if (execution.tool === "lead_search_shortlist") {
    const shortlistedUrls = Array.isArray(payload.shortlistedUrls) ? payload.shortlistedUrls : [];
    for (const raw of shortlistedUrls) {
      const url = asString(raw);
      if (!url) {
        continue;
      }
      cards.push({
        url,
        title: null,
        date: normalizeSourceDate(url),
        claim: "Shortlisted as a candidate source for follow-up fetch.",
        quote: null,
        sourceTool: execution.tool
      });
    }
    return cards;
  }

  if (execution.tool === "web_fetch") {
    const pages = context.getFetchedPages();
    for (const page of pages.slice(0, 30)) {
      const claim =
        toSourceClaim(page.text, 240)
        || toSourceClaim(page.listItems?.[0] ?? "", 240)
        || toSourceClaim(page.tableRows?.[0] ?? "", 240);
      if (!claim) {
        continue;
      }
      cards.push({
        url: page.url,
        title: page.title || null,
        date: normalizeSourceDate(`${page.url} ${page.title ?? ""} ${page.text.slice(0, 260)}`),
        claim,
        quote: extractQuoteSnippet(page.text),
        sourceTool: execution.tool
      });
    }
    return cards;
  }

  return [];
}

function updateSpecialistProgress(progress: SpecialistProgressState, result: ToolExecutionResult): void {
  if (result.status === "error") {
    const message = (result.error ?? "").toLowerCase();
    if (result.tool === "search" && /\btimeout\b|timed out|aborted due to timeout/.test(message)) {
      progress.searchTimeoutCount += 1;
    }
    if (progress.errorSamples.length < 6) {
      progress.errorSamples.push(`${result.tool}: ${result.error ?? "execution_failed"}`);
    }
    return;
  }

  progress.successfulToolCalls += 1;
  const payload = result.result ?? {};
  const payloadText = JSON.stringify(payload);
  for (const url of extractUrls(payloadText)) {
    progress.sourceUrls.add(url);
  }

  if (result.tool === "web_fetch") {
    const pagesFetched = typeof payload.pagesFetched === "number" ? payload.pagesFetched : 0;
    progress.fetchedPageCount += Math.max(0, pagesFetched);
  }

  if (result.tool === "writer_agent") {
    const content = typeof payload.content === "string" ? payload.content : "";
    const draftQuality = typeof payload.draftQuality === "string" ? payload.draftQuality : undefined;
    const fallbackUsed = payload.fallbackUsed === true;
    const shouldCountDraftProgress = draftQuality === "complete" || (!draftQuality && !fallbackUsed);
    if (shouldCountDraftProgress) {
      progress.draftWordCount = Math.max(progress.draftWordCount, countWords(content));
      progress.citationCount = Math.max(progress.citationCount, extractUrls(content).length);
    } else {
      const failureMessage = typeof payload.failureMessage === "string" ? payload.failureMessage : "";
      const fallbackReason = typeof payload.fallbackReason === "string" ? payload.fallbackReason : "writer_fallback";
      if (progress.errorSamples.length < 6) {
        progress.errorSamples.push(
          `writer_agent: ${truncateForPrompt(failureMessage || fallbackReason, 140)}`
        );
      }
    }
  }

  if (result.tool === "search" && Array.isArray(payload.topResults)) {
    for (const item of payload.topResults) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const url = (item as Record<string, unknown>).url;
      if (typeof url === "string" && url.trim()) {
        progress.sourceUrls.add(url.trim());
      }
    }
  }

  if (result.tool === "lead_search_shortlist") {
    const urls = Array.isArray(payload.shortlistedUrls) ? payload.shortlistedUrls : [];
    for (const url of urls) {
      const normalized = normalizeCandidateUrl(url);
      if (normalized) {
        progress.sourceUrls.add(normalized);
      }
    }
  }

  if (result.tool === "web_fetch") {
    const pages = Array.isArray(payload.samplePages) ? payload.samplePages : [];
    for (const page of pages) {
      if (!page || typeof page !== "object") {
        continue;
      }
      const normalized = normalizeCandidateUrl((page as Record<string, unknown>).url);
      if (normalized) {
        progress.sourceUrls.add(normalized);
      }
    }
  }
}

function derivePhaseTransitionHint(
  contract: SpecialistTaskContract,
  progress: SpecialistProgressState,
  artifactCount: number
): SpecialistPhaseTransitionHint {
  if (!(contract.requiresDraft || contract.requiresCitations)) {
    return null;
  }
  if (progress.sourceUrls.size > 0 && progress.fetchedPageCount === 0) {
    return "discovery_complete_fetch_pending";
  }
  if (progress.fetchedPageCount > 0 && progress.draftWordCount === 0) {
    return "fetch_complete_synthesis_pending";
  }
  if (progress.draftWordCount > 0 && artifactCount === 0) {
    return "synthesis_complete_persist_pending";
  }
  return null;
}

function buildSearchRetryProfile(progress: SpecialistProgressState, consecutiveSearchOnlyIterations: number): SearchRetryProfile {
  if (progress.searchTimeoutCount >= 2 || consecutiveSearchOnlyIterations >= 3) {
    return {
      mode: "degraded",
      timeoutCount: progress.searchTimeoutCount,
      recommendation:
        "Search is degraded. Use one concise query per iteration, then transition to fetch/synthesis from existing URLs.",
      maxParallelSearchActions: 1
    };
  }
  if (progress.searchTimeoutCount >= 1) {
    return {
      mode: "flaky",
      timeoutCount: progress.searchTimeoutCount,
      recommendation: "Search is flaky. Narrow query breadth and prioritize downstream fetch once URLs are available.",
      maxParallelSearchActions: 1
    };
  }
  return {
    mode: "stable",
    timeoutCount: 0,
    recommendation: "Search appears stable.",
    maxParallelSearchActions: 3
  };
}

function evaluateSpecialistContractGate(args: {
  contract: SpecialistTaskContract;
  progress: SpecialistProgressState;
  responseText: string | null;
}): { satisfied: boolean; unmet: string[] } {
  const unmet: string[] = [];
  if (args.contract.requiresDraft) {
    const responseWords = countWords(args.responseText ?? "");
    const hasDraft = args.progress.draftWordCount >= 120 || responseWords >= 180;
    if (!hasDraft) {
      unmet.push("draft_text_missing");
    }
  }
  if (args.contract.requiresCitations) {
    const responseCitationCount = extractUrls(args.responseText ?? "").length;
    const citationCount = Math.max(args.progress.citationCount, responseCitationCount);
    if (citationCount < args.contract.minimumCitationCount) {
      unmet.push("citation_evidence_missing");
    }
  }
  return {
    satisfied: unmet.length === 0,
    unmet
  };
}

function buildResearchFailureSummary(progress: SpecialistProgressState, observations: Array<{ iteration: number; summary: string }>): string {
  const recent = observations.slice(-4).map((item) => `iter ${item.iteration}: ${item.summary}`).join(" | ");
  const errors = progress.errorSamples.length > 0 ? progress.errorSamples.join(" | ") : "none";
  return [
    "I couldn't finish a publish-ready draft within this run budget.",
    `Progress so far: ${progress.sourceUrls.size} sources discovered, ${progress.fetchedPageCount} pages fetched, ${progress.draftWordCount} draft words, ${progress.citationCount} citations.`,
    `Most recent blockers: ${errors}.`,
    `Recent loop notes: ${recent || "none"}.`
  ].join(" ");
}

function createToolContext(options: SpecialistToolLoopOptions, deadlineAtMs: number): LeadAgentToolContext {
  const state: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: options.leadExecutionBrief?.requestedLeadCount ?? 0,
    fetchedPages: [],
    shortlistedUrls: [],
    executionBrief: options.leadExecutionBrief,
    researchSourceCards: []
  };

  return {
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
    addLeads: (incomingLeads) => {
      let addedCount = 0;
      for (const lead of incomingLeads) {
        const existingIndex = state.leads.findIndex(
          (item) => item.companyName === lead.companyName && item.sourceUrl === lead.sourceUrl
        );
        if (existingIndex >= 0) {
          if (lead.confidence > (state.leads[existingIndex]?.confidence ?? 0)) {
            state.leads[existingIndex] = lead;
          }
          continue;
        }
        state.leads.push(lead);
        addedCount += 1;
      }
      return { addedCount, totalCount: state.leads.length };
    },
    addArtifact: (artifactPath) => {
      if (!state.artifacts.includes(artifactPath)) {
        state.artifacts.push(artifactPath);
      }
    },
    setFetchedPages: (pages) => {
      state.fetchedPages = pages;
    },
    getFetchedPages: () => state.fetchedPages,
    setShortlistedUrls: (urls) => {
      state.shortlistedUrls = Array.from(new Set(urls.map((item) => item.trim()).filter(Boolean)));
    },
    getShortlistedUrls: () => state.shortlistedUrls ?? [],
    setResearchSourceCards: (cards) => {
      state.researchSourceCards = cards;
    },
    getResearchSourceCards: () => state.researchSourceCards ?? []
  };
}

export async function runSpecialistToolLoop(options: SpecialistToolLoopOptions): Promise<RunOutcome> {
  if (!options.openAiApiKey) {
    return {
      status: "failed",
      assistantText: `${options.skillName} requires OpenAI API access for planning.`
    };
  }

  const discoveredTools = await discoverLeadAgentTools();
  const availableTools = applyToolAllowlist(discoveredTools, options.toolAllowlist);
  if (availableTools.size === 0) {
    return {
      status: "failed",
      assistantText: `${options.skillName} has no available tools configured.`
    };
  }

  const structuredChatRunner = options.structuredChatRunner ?? openAiClient.runOpenAiStructuredChatWithDiagnostics;
  const startMs = Date.now();
  const deadlineAtMs = startMs + options.maxDurationMs;
  const toolContext = createToolContext(options, deadlineAtMs);
  const taskContract = buildSpecialistTaskContract(options);
  const progress = createSpecialistProgressState();
  const observations: Array<{ iteration: number; summary: string; outcome?: string }> = [];
  let plannerCallsUsed = 0;
  let toolCallsUsed = 0;
  let consecutivePlannerFailures = 0;
  let consecutiveSearchOnlyIterations = 0;
  let repeatedStableSuccessIterations = 0;
  let phaseTransitionHintRaised = false;
  let previousIterationSignature: string | null = null;
  let lastSuccessfulExecution: ToolExecutionResult | null = null;
  let lastPhaseState: SpecialistPhase | null = null;
  let consecutiveHealthySearchStatusChecks = 0;
  let lowValueIterationStreak = 0;
  const recentEfficiency: Array<{ iteration: number; valueDelta: number; costScore: number; efficiency: number }> = [];
  const schemaFailureStreakByTool = new Map<string, number>();
  const schemaRecoveryTools = new Set<string>();

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "specialist_loop_started",
    payload: {
      skillName: options.skillName,
      skillDescription: options.skillDescription,
      maxIterations: options.maxIterations,
      maxDurationMs: options.maxDurationMs,
      maxToolCalls: options.maxToolCalls,
      taskContract,
      availableTools: Array.from(availableTools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputHint: tool.inputHint,
        inputContract: getToolInputContract(tool.name)
      }))
    },
    timestamp: nowIso()
  });

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    if (await options.isCancellationRequested()) {
      return {
        status: "cancelled",
        assistantText: `${options.skillName} cancelled by user request.`,
        artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
      };
    }
    if (Date.now() >= deadlineAtMs || plannerCallsUsed >= options.plannerMaxCalls || toolCallsUsed >= options.maxToolCalls) {
      break;
    }
    const currentPhase = deriveSpecialistPhase(taskContract, progress, toolContext.state.artifacts.length);
    const phaseTransitionHint = derivePhaseTransitionHint(taskContract, progress, toolContext.state.artifacts.length);
    const retryProfile = buildSearchRetryProfile(progress, consecutiveSearchOnlyIterations);
    const expectedToolFamily = expectedPhaseToolFamily(currentPhase, options.skillName);

    if (lastPhaseState !== currentPhase) {
      lastPhaseState = currentPhase;
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "specialist_phase_state",
        payload: {
          skillName: options.skillName,
          iteration,
          phase: currentPhase,
          expectedToolFamily
        },
        timestamp: nowIso()
      });
    }

    const plannerDiagnostic = await structuredChatRunner(
      {
        apiKey: options.openAiApiKey,
        schemaName: `${options.skillName}_planner`,
        jsonSchema: SPECIALIST_PLANNER_JSON_SCHEMA,
        messages: [
          {
            role: "system",
            content: buildSpecialistPlannerSystemPrompt(options)
          },
          {
            role: "user",
            content: JSON.stringify({
              objective: options.message,
              iteration,
              remainingMs: Math.max(0, deadlineAtMs - Date.now()),
              remainingToolCalls: Math.max(0, options.maxToolCalls - toolCallsUsed),
              taskContract,
              progress: {
                successfulToolCalls: progress.successfulToolCalls,
                sourceUrlCount: progress.sourceUrls.size,
                fetchedPageCount: progress.fetchedPageCount,
                draftWordCount: progress.draftWordCount,
                citationCount: progress.citationCount,
                searchTimeoutCount: progress.searchTimeoutCount
              },
              researchScratchpad: {
                sourceCardCount: toolContext.getResearchSourceCards?.().length ?? 0,
                sampleSourceCards: (toolContext.getResearchSourceCards?.() ?? [])
                  .slice(-5)
                  .map((card) => ({
                    url: card.url,
                    title: card.title,
                    date: card.date,
                    claim: card.claim
                  }))
              },
              loopShape: {
                consecutiveSearchOnlyIterations
              },
              phaseState: {
                current: currentPhase,
                expectedToolFamily
              },
              phaseTransitionHint,
              retryProfile,
              schemaRecovery: {
                repeatedSchemaFailureTools: Array.from(schemaRecoveryTools),
                active: schemaRecoveryTools.size > 0
              },
              actionEconomy: {
                lowValueIterationStreak,
                recentEfficiency: recentEfficiency.slice(-3)
              },
              availableTools: Array.from(availableTools.values()).map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputHint: tool.inputHint,
                inputContract: getToolInputContract(tool.name)
              })),
              recentObservations: observations.slice(-5)
            })
          }
        ]
      },
      SpecialistPlannerOutputSchema
    );

    plannerCallsUsed += 1;
    if (plannerDiagnostic.usage) {
      await options.runStore.addLlmUsage(options.runId, plannerDiagnostic.usage, 1);
    }
    if (!plannerDiagnostic.result) {
      consecutivePlannerFailures += 1;
      const failureClass = plannerDiagnostic.failureClass ?? classifyStructuredFailure(plannerDiagnostic);
      const failureMessage = plannerDiagnostic.failureMessage?.slice(0, 220) ?? "planner_failed";
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "specialist_planner_failed",
        payload: {
          skillName: options.skillName,
          iteration,
          failureClass,
          failureCode: plannerDiagnostic.failureCode ?? "unknown",
          attempts: plannerDiagnostic.attempts ?? 1,
          message: failureMessage
        },
        timestamp: nowIso()
      });
      observations.push({
        iteration,
        summary: `planner_failed:${failureClass}`,
        outcome: failureMessage
      });
      if (failureClass === "policy_block") {
        return {
          status: "failed",
          assistantText: `${options.skillName} blocked by policy/auth: ${failureMessage}`,
          artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
        };
      }
      if (failureClass === "network" || failureClass === "timeout") {
        const delayMs = computeRetryDelayMs(
          consecutivePlannerFailures,
          {
            maxAttempts: 4,
            baseDelayMs: 200,
            maxDelayMs: 1500,
            jitterRatio: 0.15
          },
          undefined
        );
        await sleep(delayMs);
      }
      if (consecutivePlannerFailures >= 3) {
        break;
      }
      continue;
    }
    consecutivePlannerFailures = 0;

    const plan = plannerDiagnostic.result;
    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "specialist_plan_created",
      payload: {
        skillName: options.skillName,
        iteration,
        thought: plan.thought,
        actionType: plan.actionType,
        singleTool: plan.singleTool,
        parallelActions: plan.parallelActions,
        phaseState: {
          current: currentPhase,
          expectedToolFamily
        },
        phaseTransitionHint,
        retryProfile
      },
      timestamp: nowIso()
    });

    if (plan.actionType === "respond") {
      const contractGate = evaluateSpecialistContractGate({
        contract: taskContract,
        progress,
        responseText: plan.responseText
      });
      if (!contractGate.satisfied) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_contract_blocked",
          payload: {
            skillName: options.skillName,
            iteration,
            unmet: contractGate.unmet,
            progress: {
              sourceUrlCount: progress.sourceUrls.size,
              fetchedPageCount: progress.fetchedPageCount,
              draftWordCount: progress.draftWordCount,
              citationCount: progress.citationCount
            }
          },
          timestamp: nowIso()
        });
        observations.push({
          iteration,
          summary: `contract_blocked:${contractGate.unmet.join(",")}`
        });
        continue;
      }
      return {
        status: "completed",
        assistantText: plan.responseText ?? buildFallbackAssistantText(options.skillName, observations),
        artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
      };
    }

    const singleActionDefaultInput =
      plan.actionType === "single" && plan.singleTool
        ? defaultToolInputJson(plan.singleTool, options.message)
        : null;
    const shouldDefaultSingleInput =
      plan.actionType === "single" &&
      Boolean(plan.singleTool) &&
      (
        !plan.singleInputJson ||
        !safeParseObject(plan.singleInputJson)
      ) &&
      Boolean(singleActionDefaultInput);

    const requestedActions =
      plan.actionType === "single"
        ? plan.singleTool
          ? [
              {
                tool: plan.singleTool,
                inputJson: shouldDefaultSingleInput
                  ? (singleActionDefaultInput ?? "")
                  : (plan.singleInputJson ?? "")
              }
            ]
          : []
        : (plan.parallelActions ?? []);

    let actions = requestedActions
      .map((action) => ({
        tool: action.tool.trim(),
        inputJson: action.inputJson
      }))
      .filter((action) => action.tool.length > 0 && typeof action.inputJson === "string" && action.inputJson.trim().length > 0)
      .slice(0, Math.max(1, options.maxParallelTools));

    if (
      plan.actionType === "single" &&
      plan.singleTool &&
      shouldDefaultSingleInput &&
      actions.length > 0
    ) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "specialist_plan_adjusted",
        payload: {
          skillName: options.skillName,
          iteration,
          reason: !plan.singleInputJson ? "single_action_input_defaulted" : "single_action_input_repaired",
          tool: plan.singleTool
        },
        timestamp: nowIso()
      });
    }

    if (actions.length > 0 && schemaRecoveryTools.size > 0) {
      let adjustedCount = 0;
      const adjustedActions = actions.map((action) => {
        if (!schemaRecoveryTools.has(action.tool)) {
          return action;
        }
        const repairedInputJson = normalizeActionInputForSchemaRecovery(action.tool, action.inputJson, options.message);
        if (repairedInputJson !== action.inputJson) {
          adjustedCount += 1;
          return {
            ...action,
            inputJson: repairedInputJson
          };
        }
        return action;
      });
      if (adjustedCount > 0) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: "schema_recovery_forced",
            tools: Array.from(schemaRecoveryTools),
            adjustedCount
          },
          timestamp: nowIso()
        });
        actions = adjustedActions;
      }
    }

    if (actions.length > 0) {
      const phaseLock = shouldForcePhaseTransition({
        contract: taskContract,
        progress,
        actions,
        availableToolNames: new Set(Array.from(availableTools.keys())),
        objective: options.message
      });
      if (phaseLock.forced && phaseLock.forced.length > 0) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: phaseLock.reason,
            originalActionCount: actions.length,
            adjustedActionCount: phaseLock.forced.length
          },
          timestamp: nowIso()
        });
        actions = phaseLock.forced;
      }
    }

    if (shouldApplyDiagnosticThrashGuard(actions, consecutiveHealthySearchStatusChecks)) {
      const objectiveQuery = deriveObjectiveQuery(options.message);
      let guardAdjusted: Array<{ tool: string; inputJson: string }> | null = null;
      if (availableTools.has("search")) {
        guardAdjusted = [{ tool: "search", inputJson: JSON.stringify({ query: objectiveQuery, maxResults: 10 }) }];
      } else if (availableTools.has("lead_search_shortlist")) {
        guardAdjusted = [{ tool: "lead_search_shortlist", inputJson: JSON.stringify({ query: objectiveQuery, maxResults: 10, maxUrls: 12 }) }];
      } else if (availableTools.has("web_fetch")) {
        guardAdjusted = [{ tool: "web_fetch", inputJson: JSON.stringify({ query: objectiveQuery, maxPages: 10, browseConcurrency: 3 }) }];
      }
      if (guardAdjusted) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: "diagnostic_thrash_guard",
            consecutiveHealthySearchStatusChecks,
            originalActionCount: actions.length,
            adjustedActionCount: guardAdjusted.length
          },
          timestamp: nowIso()
        });
        actions = guardAdjusted;
      }
    }

    if (actions.length > 1 && retryProfile.maxParallelSearchActions < 3) {
      let allowedSearchActions = 0;
      const adjustedActions: Array<{ tool: string; inputJson: string }> = [];
      for (const action of actions) {
        if (SEARCH_FAMILY_TOOLS.has(action.tool)) {
          if (allowedSearchActions >= retryProfile.maxParallelSearchActions) {
            continue;
          }
          allowedSearchActions += 1;
        }
        adjustedActions.push(action);
        if (adjustedActions.length >= Math.max(1, options.maxParallelTools)) {
          break;
        }
      }
      if (adjustedActions.length > 0 && adjustedActions.length < actions.length) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: "flaky_search_retry_profile",
            retryProfile,
            originalActionCount: actions.length,
            adjustedActionCount: adjustedActions.length
          },
          timestamp: nowIso()
        });
        actions = adjustedActions;
      }
    }

    if (actions.length === 0) {
      observations.push({
        iteration,
        summary: "planner_returned_no_action"
      });
      continue;
    }

    const beforeSnapshot = captureProgressSnapshot(progress, toolContext.state.artifacts.length);
    const executions = await Promise.all(
      actions.map(async (action): Promise<ToolExecutionResult> => {
        const envelope = await executeToolWithEnvelope({
          toolName: action.tool,
          inputJson: action.inputJson,
          tools: availableTools,
          context: toolContext,
          runStore: options.runStore,
          runId: options.runId
        });
        if (envelope.status === "ok" && envelope.result) {
          for (const artifactPath of extractArtifactPaths(action.tool, envelope.result)) {
            toolContext.addArtifact(artifactPath);
          }
        }
        return {
          ...envelope,
          summary:
            envelope.status === "ok"
              ? truncateForPrompt(envelope.result, 220)
              : envelope.error ?? "execution_failed"
        };
      })
    );
    const hasOnlyHealthySearchStatus =
      executions.length > 0 &&
      executions.every((execution) => {
        if (execution.tool !== "search_status" || execution.status !== "ok") {
          return false;
        }
        const payload = execution.result ?? {};
        return payload.primaryHealthy === true && payload.fallbackHealthy === true;
      });
    if (hasOnlyHealthySearchStatus) {
      consecutiveHealthySearchStatusChecks += 1;
    } else {
      consecutiveHealthySearchStatusChecks = 0;
    }
    for (const execution of executions) {
      updateSpecialistProgress(progress, execution);
      const cardDelta = deriveSourceCardsFromExecution(execution, toolContext);
      if (cardDelta.length > 0) {
        const mergedCards = mergeResearchSourceCards(toolContext.getResearchSourceCards?.() ?? [], cardDelta);
        toolContext.setResearchSourceCards?.(mergedCards);
      }
      if (execution.status === "error") {
        if (isSchemaInputError(execution.error)) {
          const nextStreak = (schemaFailureStreakByTool.get(execution.tool) ?? 0) + 1;
          schemaFailureStreakByTool.set(execution.tool, nextStreak);
          if (nextStreak >= 2) {
            schemaRecoveryTools.add(execution.tool);
          }
        } else {
          schemaFailureStreakByTool.delete(execution.tool);
          schemaRecoveryTools.delete(execution.tool);
        }
      } else {
        schemaFailureStreakByTool.delete(execution.tool);
        schemaRecoveryTools.delete(execution.tool);
      }
      if (execution.status === "ok") {
        lastSuccessfulExecution = execution;
      }
    }
    const afterSnapshot = captureProgressSnapshot(progress, toolContext.state.artifacts.length);
    const valueDelta = computeIterationValueDelta(beforeSnapshot, afterSnapshot);
    const costScore = executions.reduce((sum, execution) => sum + execution.durationMs, 0) / 1000 + executions.length * 0.35;
    const efficiency = valueDelta / Math.max(1, costScore);
    recentEfficiency.push({
      iteration,
      valueDelta: Number(valueDelta.toFixed(4)),
      costScore: Number(costScore.toFixed(4)),
      efficiency: Number(efficiency.toFixed(4))
    });
    if (recentEfficiency.length > 6) {
      recentEfficiency.shift();
    }
    if (valueDelta <= 0.05) {
      lowValueIterationStreak += 1;
    } else {
      lowValueIterationStreak = 0;
    }

    const hadSearchFamilyAction = executions.some((item) => SEARCH_FAMILY_TOOLS.has(item.tool));
    const hadDownstreamProgress = executions.some(
      (item) => item.status === "ok" && DOWNSTREAM_PROGRESS_TOOLS.has(item.tool)
    );
    if (hadSearchFamilyAction && !hadDownstreamProgress) {
      consecutiveSearchOnlyIterations += 1;
    } else {
      consecutiveSearchOnlyIterations = 0;
      if (hadDownstreamProgress) {
        phaseTransitionHintRaised = false;
      }
    }

    toolCallsUsed += executions.length;
    const summary = formatObservationSummary(executions);
    const allSucceeded = executions.length > 0 && executions.every((item) => item.status === "ok");
    const iterationSignature = executions
      .map((item) => {
        if (item.status === "ok") {
          return `${item.tool}:ok:${truncateForPrompt(item.result, 220)}`;
        }
        return `${item.tool}:error:${item.error ?? "execution_failed"}`;
      })
      .join("|");
    if (allSucceeded && previousIterationSignature === iterationSignature) {
      repeatedStableSuccessIterations += 1;
    } else {
      repeatedStableSuccessIterations = 0;
    }
    previousIterationSignature = iterationSignature;
    observations.push({
      iteration,
      summary
    });

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "observe",
      eventType: "specialist_action_result",
      payload: {
        skillName: options.skillName,
        iteration,
        summary,
        actionEconomy: {
          valueDelta: Number(valueDelta.toFixed(4)),
          costScore: Number(costScore.toFixed(4)),
          efficiency: Number(efficiency.toFixed(4)),
          lowValueIterationStreak
        },
        results: executions.map((item) => ({
          tool: item.tool,
          status: item.status,
          durationMs: item.durationMs,
          summary: item.summary,
          requiresApproval: item.requiresApproval,
          inputRepairApplied: item.inputRepairApplied,
          inputRepairStrategy: item.inputRepairStrategy,
          input: item.input,
          result: item.result,
          error: item.error
        }))
      },
      timestamp: nowIso()
    });

    const postIterationTransitionHint = derivePhaseTransitionHint(taskContract, progress, toolContext.state.artifacts.length);
    if (
      !phaseTransitionHintRaised &&
      consecutiveSearchOnlyIterations >= 2 &&
      postIterationTransitionHint !== null
    ) {
      phaseTransitionHintRaised = true;
      observations.push({
        iteration,
        summary: `phase_transition_required:${postIterationTransitionHint}`
      });
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "specialist_phase_transition_required",
        payload: {
          skillName: options.skillName,
          iteration,
          hint: postIterationTransitionHint,
          sourceUrlCount: progress.sourceUrls.size,
          fetchedPageCount: progress.fetchedPageCount,
          draftWordCount: progress.draftWordCount
        },
        timestamp: nowIso()
      });
    }

    const searchOnlyGuardThreshold =
      postIterationTransitionHint === "discovery_complete_fetch_pending" ? 4 : 3;
    if (consecutiveSearchOnlyIterations >= searchOnlyGuardThreshold) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "specialist_loop_guard_triggered",
        payload: {
          skillName: options.skillName,
          guard: "search_only_no_downstream_progress",
          consecutiveSearchOnlyIterations,
          threshold: searchOnlyGuardThreshold,
          phaseTransitionHint: postIterationTransitionHint
        },
        timestamp: nowIso()
      });
      break;
    }
    if (lowValueIterationStreak >= 4) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "specialist_loop_guard_triggered",
        payload: {
          skillName: options.skillName,
          guard: "low_value_action_thrash",
          lowValueIterationStreak,
          latestEfficiency: recentEfficiency.slice(-2)
        },
        timestamp: nowIso()
      });
      break;
    }
    if (options.skillName !== "research_agent" && repeatedStableSuccessIterations >= 2) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "specialist_loop_guard_triggered",
        payload: {
          skillName: options.skillName,
          guard: "repeated_no_change_success",
          repeatedStableSuccessIterations
        },
        timestamp: nowIso()
      });
      break;
    }
  }

  const unmetContract = evaluateSpecialistContractGate({
    contract: taskContract,
    progress,
    responseText: null
  });
  const assistantText =
    options.skillName === "research_agent" && !unmetContract.satisfied
      ? buildResearchFailureSummary(progress, observations)
      : lastSuccessfulExecution
        ? buildSpecialistResultAssistantText(options.skillName, lastSuccessfulExecution)
        : buildFallbackAssistantText(options.skillName, observations);
  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "final",
    eventType: "specialist_stop",
    payload: {
      skillName: options.skillName,
      reason: "budget_or_iteration_guardrail",
      plannerCallsUsed,
      toolCallsUsed,
      searchTimeoutCount: progress.searchTimeoutCount,
      sourceUrlCount: progress.sourceUrls.size,
      fetchedPageCount: progress.fetchedPageCount,
      unmetContract: unmetContract.unmet
    },
    timestamp: nowIso()
  });

  return {
    status: "completed",
    assistantText,
    artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
  };
}
