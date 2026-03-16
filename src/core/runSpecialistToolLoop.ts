import { z } from "zod";
import type { RunOutcome, SessionOutputAvailability } from "../types.js";
import * as openAiClient from "../services/openAiClient.js";
import { composeSystemPrompt } from "../prompts/composePrompt.js";
import { ALFRED_MASTER_PROMPT_VERSION, ALFRED_MASTER_SYSTEM_PROMPT } from "../prompts/master/alfred.system.js";
import type { AgentSkillRunOptions, AgentTaskContract } from "../agent/skills/types.js";
import type {
  AgentActiveWorkItem,
  AgentCandidateEntry,
  AgentCandidateSet,
  AgentEvidenceRecord,
  AgentMetadataValue,
  AgentWorkAssumption,
  AgentSynthesisState,
  LeadAgentState,
  LeadAgentToolContext,
  ResearchSourceCard
} from "../agent/types.js";
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
  responseKind?: "final" | "clarification" | "progress" | null;
  singleTool: string | null;
  singleInputJson: string | null;
  parallelActions: Array<{ tool: string; inputJson: string }> | null;
  responseText: string | null;
}

type ToolExecutionResult = ToolExecutionEnvelope & { summary: string };

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
  lastWriterOutputAvailability: SessionOutputAvailability | null;
  lastWriterDeliverableStatus: "complete" | "partial" | "insufficient" | null;
  lastWriterProcessCommentaryDetected: boolean;
}

interface ProgressSnapshot {
  sourceUrlCount: number;
  fetchedPageCount: number;
  draftWordCount: number;
  artifactCount: number;
}

interface EvidenceSnapshot {
  sourceUrlCount: number;
  fetchedPageCount: number;
  sourceCardCount: number;
}

interface EvidenceThresholds {
  minFetchedPagesForDraft: number;
  minSourceCardsForDraft: number;
  minSourceCardsForRevise: number;
}

interface ActiveWorkStateSnapshot {
  assumptions: AgentWorkAssumption[];
  unresolvedItems: string[];
  activeWorkItems: AgentActiveWorkItem[];
  candidateSets: AgentCandidateSet[];
  evidenceRecords: AgentEvidenceRecord[];
  synthesisState: AgentSynthesisState;
}

interface WriterReadinessState {
  evidenceReady: boolean;
  finalizeReady: boolean;
  hasReusableEvidence: boolean;
  missingEvidence: string[];
  timeBudgetReady: boolean;
  outputContractReady: boolean;
  minimumRemainingMs: number;
}

function deriveWriterResultOutputAvailability(payload: Record<string, unknown>): SessionOutputAvailability {
  const deliverableStatus =
    payload.deliverableStatus === "complete" || payload.deliverableStatus === "partial" || payload.deliverableStatus === "insufficient"
      ? payload.deliverableStatus
      : null;
  const draftQuality = typeof payload.draftQuality === "string" ? payload.draftQuality : null;
  const processCommentaryDetected = payload.processCommentaryDetected === true;
  const hasRenderableBody =
    (typeof payload.content === "string" && payload.content.trim().length > 0)
    || (typeof payload.outputPath === "string" && payload.outputPath.trim().length > 0);

  if (draftQuality === "complete" || deliverableStatus === "complete") {
    return hasRenderableBody ? "body_available" : "missing";
  }
  if (deliverableStatus === "partial" && !processCommentaryDetected) {
    return hasRenderableBody ? "body_available" : "metadata_only";
  }
  if (hasRenderableBody || typeof payload.summary === "string") {
    return "metadata_only";
  }
  return "missing";
}

const SPECIALIST_PLANNER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 600 },
    actionType: { type: "string", enum: ["single", "parallel", "respond"] },
    responseKind: { anyOf: [{ type: "string", enum: ["final", "clarification", "progress"] }, { type: "null" }] },
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
  required: ["thought", "actionType", "responseKind", "singleTool", "singleInputJson", "parallelActions", "responseText"]
} as const;

const SpecialistPlannerOutputSchema: z.ZodType<SpecialistPlannerOutput> = z.object({
  thought: z.string().min(1).max(600),
  actionType: z.enum(["single", "parallel", "respond"]),
  responseKind: z.enum(["final", "clarification", "progress"]).nullable().optional(),
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
const DOWNSTREAM_PROGRESS_TOOLS = new Set(["web_fetch", "lead_extract", "writer_agent", "article_writer", "file_write", "write_csv"]);
const DIAGNOSTIC_TOOLS = new Set(["search_status", "run_diagnostics"]);
const DRAFT_TOOL_NAMES = new Set(["writer_agent", "article_writer"]);
const MIN_FETCHED_PAGES_FOR_DRAFT = 2;
const MIN_SOURCE_CARDS_FOR_DRAFT = 3;
const MIN_SOURCE_CARDS_FOR_WRITER_REVISE = 1;

function deriveEvidenceThresholds(contract: AgentTaskContract): EvidenceThresholds {
  let minFetchedPagesForDraft = MIN_FETCHED_PAGES_FOR_DRAFT;
  let minSourceCardsForDraft = MIN_SOURCE_CARDS_FOR_DRAFT;

  if (contract.targetWordCount && contract.targetWordCount >= 1100) {
    minFetchedPagesForDraft = Math.max(minFetchedPagesForDraft, 5);
    minSourceCardsForDraft = Math.max(minSourceCardsForDraft, 8);
  } else if (contract.targetWordCount && contract.targetWordCount >= 800) {
    minFetchedPagesForDraft = Math.max(minFetchedPagesForDraft, 4);
    minSourceCardsForDraft = Math.max(minSourceCardsForDraft, 6);
  }

  if (contract.requiresCitations) {
    minSourceCardsForDraft = Math.max(minSourceCardsForDraft, contract.minimumCitationCount + 2);
  }

  return {
    minFetchedPagesForDraft,
    minSourceCardsForDraft,
    minSourceCardsForRevise: Math.max(MIN_SOURCE_CARDS_FOR_WRITER_REVISE, Math.min(3, minSourceCardsForDraft - 2))
  };
}

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

function normalizeRequestedOutputPath(pathValue: string): string {
  return pathValue.trim().replace(/[).,;:!?]+$/, "");
}

function extractOutputPathFromObjective(objective: string): string | null {
  const match = objective.match(/\bworkspace\/[^\s"'`]+/i);
  return match?.[0] ? normalizeRequestedOutputPath(match[0]) : null;
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
  if (tool === "writer_agent" || tool === "article_writer") {
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
  contract: AgentTaskContract;
  progress: SpecialistProgressState;
  actions: Array<{ tool: string; inputJson: string }>;
  availableToolNames: Set<string>;
  objective: string;
  currentPhase: SpecialistPhase;
  phaseTransitionHint: SpecialistPhaseTransitionHint;
}): { forced: Array<{ tool: string; inputJson: string }> | null; reason: string | null } {
  const isSearchOnly = args.actions.length > 0 && args.actions.every((item) => SEARCH_FAMILY_TOOLS.has(item.tool));
  if (!isSearchOnly) {
    return { forced: null, reason: null };
  }

  if (
    (args.contract.requiresAssembly === true || args.contract.requiresDraft || args.contract.requiresCitations) &&
    (args.currentPhase === "fetch" || args.phaseTransitionHint === "discovery_complete_fetch_pending") &&
    args.progress.sourceUrls.size > 0 &&
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

  return { forced: null, reason: null };
}

function deriveSpecialistPhase(
  contract: AgentTaskContract,
  progress: SpecialistProgressState,
  artifactCount: number
): SpecialistPhase {
  const requiresAssembly = contract.requiresAssembly === true || contract.requiresDraft || contract.requiresCitations;
  if (!requiresAssembly) {
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
      return skillName === "research_agent" ? "writer_agent/article_writer" : "writer_agent/article_writer/lead_extract";
    case "persist":
      return skillName === "research_agent"
        ? "writer_agent/article_writer(outputPath)/file_write"
        : "file_write/write_csv/writer_agent/article_writer(outputPath)";
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
    case "article_writer":
      return JSON.stringify({ instruction: objective.slice(0, 1200), maxWords: 950, format: "blog_post" });
    default:
      return null;
  }
}

function buildEvidenceRecoveryAction(
  availableToolNames: Set<string>,
  objective: string,
  sourceUrls: Set<string>
): Array<{ tool: string; inputJson: string }> | null {
  if (availableToolNames.has("web_fetch")) {
    const urls = selectFetchUrlsForHandoff(sourceUrls, 8);
    return [
      {
        tool: "web_fetch",
        inputJson: urls.length > 0
          ? JSON.stringify({
              urls,
              maxPages: Math.min(8, urls.length),
              browseConcurrency: 3
            })
          : JSON.stringify({
              query: deriveObjectiveQuery(objective),
              maxPages: 8,
              browseConcurrency: 3
            })
      }
    ];
  }

  if (availableToolNames.has("search")) {
    return [
      {
        tool: "search",
        inputJson: JSON.stringify({
          query: deriveObjectiveQuery(objective),
          maxResults: 10
        })
      }
    ];
  }

  if (availableToolNames.has("lead_search_shortlist")) {
    return [
      {
        tool: "lead_search_shortlist",
        inputJson: JSON.stringify({
          query: deriveObjectiveQuery(objective),
          maxResults: 10,
          maxUrls: 12
        })
      }
    ];
  }

  return null;
}

function assessWriterReadiness(args: {
  contract: AgentTaskContract;
  thresholds: EvidenceThresholds;
  progress: SpecialistProgressState;
  sourceCardCount: number;
  synthesisState: AgentSynthesisState;
  remainingMs: number;
}): WriterReadinessState {
  const missingEvidence: string[] = [];
  const fetchedReady = args.progress.fetchedPageCount >= args.thresholds.minFetchedPagesForDraft;
  const sourceCardsReady = args.sourceCardCount >= args.thresholds.minSourceCardsForDraft;
  const reusableFetch = args.progress.fetchedPageCount >= Math.max(2, args.thresholds.minFetchedPagesForDraft - 1);
  const reusableSourceCards = args.sourceCardCount >= Math.max(1, args.thresholds.minSourceCardsForDraft - 2);
  const reusableDiscovery = args.progress.sourceUrls.size >= 4;

  if (args.contract.requiresDraft && !fetchedReady) {
    missingEvidence.push(
      `Fetched evidence below threshold (${args.progress.fetchedPageCount}/${args.thresholds.minFetchedPagesForDraft}).`
    );
  }
  if (args.contract.requiresDraft && !sourceCardsReady) {
    missingEvidence.push(
      `Structured evidence below threshold (${args.sourceCardCount}/${args.thresholds.minSourceCardsForDraft}).`
    );
  }

  const outputContractReady =
    !args.contract.requestedOutputPath || args.contract.requestedOutputPath.trim().length > 0;
  const minimumRemainingMs = args.contract.requiresDraft
    ? 55_000
    : (args.contract.requiresAssembly ? 40_000 : 25_000);
  const timeBudgetReady = args.remainingMs >= minimumRemainingMs;
  if (!timeBudgetReady) {
    missingEvidence.push(
      `Remaining budget is below the minimum recommended writer window (${args.remainingMs}/${minimumRemainingMs}ms).`
    );
  }
  if (!outputContractReady) {
    missingEvidence.push("Output contract is incomplete.");
  }

  const evidenceReady = !args.contract.requiresDraft || (fetchedReady && sourceCardsReady);
  const hasReusableEvidence = reusableFetch || reusableSourceCards || reusableDiscovery;
  const finalizeReady =
    args.synthesisState.readyForSynthesis
    || hasReusableEvidence
    || evidenceReady;

  return {
    evidenceReady,
    finalizeReady,
    hasReusableEvidence,
    missingEvidence,
    timeBudgetReady,
    outputContractReady,
    minimumRemainingMs
  };
}

function buildAssemblyAction(args: {
  availableToolNames: Set<string>;
  contract: AgentTaskContract;
  objective: string;
  requestedOutputPath: string | null;
}): Array<{ tool: string; inputJson: string }> | null {
  const draftTool = args.availableToolNames.has("article_writer")
    ? "article_writer"
    : (args.availableToolNames.has("writer_agent") ? "writer_agent" : null);
  if (!draftTool) {
    return null;
  }
  const assemblyInput: Record<string, unknown> = {
    instruction: [
      `Assemble the current deliverable from the evidence already collected.`,
      `Required deliverable: ${args.contract.requiredDeliverable}`,
      args.contract.doneCriteria.length > 0
        ? `Done criteria: ${args.contract.doneCriteria.join(" ")}`
        : null,
      "Do not restart discovery unless the current evidence is explicitly insufficient.",
      args.contract.requiresCitations
        ? "Include explicit source links for factual claims."
        : "Use the collected evidence directly and note any uncertainty honestly."
    ].filter(Boolean).join(" "),
    maxWords: args.contract.targetWordCount && args.contract.targetWordCount > 0
      ? Math.max(300, Math.min(1400, args.contract.targetWordCount))
      : 1100,
    format: args.contract.requiresDraft ? "blog_post" : "memo"
  };
  if (args.requestedOutputPath) {
    assemblyInput.outputPath = args.requestedOutputPath;
  }
  return [
    {
      tool: draftTool,
      inputJson: JSON.stringify(assemblyInput)
    }
  ];
}

function shouldApplyEvidenceGapGuard(args: {
  contract: AgentTaskContract;
  actions: Array<{ tool: string; inputJson: string }>;
  availableToolNames: Set<string>;
  objective: string;
  progress: SpecialistProgressState;
  writerReadiness: WriterReadinessState;
  thresholds: EvidenceThresholds;
  sourceCardCount: number;
}): {
  adjusted: Array<{ tool: string; inputJson: string }> | null;
  reason: string | null;
  detail: {
    fetchedPageCount: number;
    sourceCardCount: number;
    minFetchedPages: number;
    minSourceCards: number;
    writerReady: boolean;
    missingEvidence: string[];
    timeBudgetReady: boolean;
  };
} {
  const detail = {
    fetchedPageCount: args.progress.fetchedPageCount,
    sourceCardCount: args.sourceCardCount,
    minFetchedPages: args.thresholds.minFetchedPagesForDraft,
    minSourceCards: args.thresholds.minSourceCardsForDraft,
    writerReady: args.writerReadiness.evidenceReady,
    missingEvidence: args.writerReadiness.missingEvidence,
    timeBudgetReady: args.writerReadiness.timeBudgetReady
  };
  if (!args.contract.requiresDraft || args.progress.draftWordCount > 0) {
    return { adjusted: null, reason: null, detail };
  }
  const includesDraftAction = args.actions.some((item) => DRAFT_TOOL_NAMES.has(item.tool));
  if (!includesDraftAction) {
    return { adjusted: null, reason: null, detail };
  }
  if (args.writerReadiness.evidenceReady) {
    return { adjusted: null, reason: null, detail };
  }

  return {
    adjusted: buildEvidenceRecoveryAction(args.availableToolNames, args.objective, args.progress.sourceUrls),
    reason: "insufficient_evidence_for_writer",
    detail
  };
}

function hasEvidenceAdvanced(current: EvidenceSnapshot, previous: EvidenceSnapshot | null): boolean {
  if (!previous) {
    return true;
  }
  return (
    current.sourceUrlCount > previous.sourceUrlCount
    || current.fetchedPageCount > previous.fetchedPageCount
    || current.sourceCardCount > previous.sourceCardCount
  );
}

function shouldApplyWriterRetryBudgetGuard(args: {
  actions: Array<{ tool: string; inputJson: string }>;
  draftFailureStreak: number;
  evidenceAdvancedSinceLastDraft: boolean;
  availableToolNames: Set<string>;
  progress: SpecialistProgressState;
  objective: string;
  writerReadiness: WriterReadinessState;
  sourceCardCount: number;
}): {
  adjusted: Array<{ tool: string; inputJson: string }> | null;
  reason: string | null;
  detail: {
    draftFailureStreak: number;
    evidenceAdvancedSinceLastDraft: boolean;
    sourceCardCount: number;
    strategy: "none" | "revise_existing_evidence" | "retrieve_more_evidence";
  };
} {
  const detail = {
    draftFailureStreak: args.draftFailureStreak,
    evidenceAdvancedSinceLastDraft: args.evidenceAdvancedSinceLastDraft,
    sourceCardCount: args.sourceCardCount,
    strategy: "none" as const
  };
  const includesDraftAction = args.actions.some((item) => DRAFT_TOOL_NAMES.has(item.tool));
  if (!includesDraftAction) {
    return { adjusted: null, reason: null, detail };
  }
  if (args.draftFailureStreak <= 0 || args.evidenceAdvancedSinceLastDraft) {
    return { adjusted: null, reason: null, detail };
  }

  if (args.writerReadiness.hasReusableEvidence) {
    const draftTool =
      args.actions.find((item) => DRAFT_TOOL_NAMES.has(item.tool))?.tool
      ?? (args.availableToolNames.has("article_writer") ? "article_writer" : "writer_agent");
    const outputPath = extractOutputPathFromObjective(args.objective);
    const revisionInput: Record<string, unknown> = {
      instruction:
        "Revise and complete the draft using the evidence already collected. Improve structure and citations before requesting any new retrieval.",
      maxWords: 950,
      format: "blog_post"
    };
    if (outputPath) {
      revisionInput.outputPath = outputPath;
    }
    return {
      adjusted: [
        {
          tool: draftTool,
          inputJson: JSON.stringify(revisionInput)
        }
      ],
      reason: "writer_retry_budget_guard",
      detail: {
        ...detail,
        strategy: "revise_existing_evidence"
      }
    };
  }

  return {
    adjusted: buildEvidenceRecoveryAction(args.availableToolNames, args.objective, args.progress.sourceUrls),
    reason: "writer_retry_budget_guard",
    detail: {
      ...detail,
      strategy: "retrieve_more_evidence"
    }
  };
}

function shouldApplyLowBudgetFinalizeGuard(args: {
  skillName: string;
  remainingMs: number;
  actions: Array<{ tool: string; inputJson: string }>;
  availableToolNames: Set<string>;
  objective: string;
  requestedOutputPath: string | null;
  targetWordCount?: number | null;
  progress: SpecialistProgressState;
  sourceCardCount: number;
  writerReadiness: WriterReadinessState;
}): {
  adjusted: Array<{ tool: string; inputJson: string }> | null;
  reason: string | null;
  detail: {
    remainingMs: number;
    fetchedPageCount: number;
    sourceCardCount: number;
    draftWordCount: number;
    finalizeReady: boolean;
    missingEvidence: string[];
    timeBudgetReady: boolean;
  };
} {
  const detail = {
    remainingMs: args.remainingMs,
    fetchedPageCount: args.progress.fetchedPageCount,
    sourceCardCount: args.sourceCardCount,
    draftWordCount: args.progress.draftWordCount,
    finalizeReady: args.writerReadiness.finalizeReady,
    missingEvidence: args.writerReadiness.missingEvidence,
    timeBudgetReady: args.writerReadiness.timeBudgetReady
  };
  if (args.skillName !== "research_agent") {
    return { adjusted: null, reason: null, detail };
  }
  if (args.remainingMs > 45_000) {
    return { adjusted: null, reason: null, detail };
  }
  const hasSearchHeavyMix =
    args.actions.some((item) => SEARCH_FAMILY_TOOLS.has(item.tool))
    && !args.actions.some((item) => DRAFT_TOOL_NAMES.has(item.tool));
  if (!hasSearchHeavyMix) {
    return { adjusted: null, reason: null, detail };
  }
  if (!args.writerReadiness.finalizeReady) {
    return { adjusted: null, reason: null, detail };
  }
  if (!args.writerReadiness.timeBudgetReady) {
    return { adjusted: null, reason: null, detail };
  }
  const draftTool = args.availableToolNames.has("article_writer")
    ? "article_writer"
    : (args.availableToolNames.has("writer_agent") ? "writer_agent" : null);
  if (!draftTool) {
    return { adjusted: null, reason: null, detail };
  }
  const outputPath = args.requestedOutputPath ?? extractOutputPathFromObjective(args.objective);
  const revisionInput: Record<string, unknown> = {
    instruction:
      "Finalize the best possible draft now from existing evidence. Improve structure and include explicit source links. Do not start new discovery loops.",
    maxWords: args.targetWordCount && args.targetWordCount > 0
      ? Math.max(300, Math.min(1400, args.targetWordCount))
      : 950,
    format: "blog_post"
  };
  if (outputPath) {
    revisionInput.outputPath = outputPath;
  }
  return {
    adjusted: [
      {
        tool: draftTool,
        inputJson: JSON.stringify(revisionInput)
      }
    ],
    reason: "low_budget_finalize_draft",
    detail
  };
}

export function shouldApplyAssemblyGuard(args: {
  skillName: string;
  phase: SpecialistPhase;
  actions: Array<{ tool: string; inputJson: string }>;
  availableToolNames: Set<string>;
  objective: string;
  contract: AgentTaskContract;
  requestedOutputPath: string | null;
  writerReadiness: WriterReadinessState;
}): {
  adjusted: Array<{ tool: string; inputJson: string }> | null;
  reason: string | null;
} {
  if (args.skillName !== "research_agent") {
    return { adjusted: null, reason: null };
  }
  if (args.phase !== "synthesis") {
    return { adjusted: null, reason: null };
  }
  const hasSearchHeavyMix =
    args.actions.some((item) => SEARCH_FAMILY_TOOLS.has(item.tool))
    && !args.actions.some((item) => DRAFT_TOOL_NAMES.has(item.tool));
  if (!hasSearchHeavyMix) {
    return { adjusted: null, reason: null };
  }
  if (!args.writerReadiness.evidenceReady) {
    return { adjusted: null, reason: null };
  }
  if (!args.writerReadiness.timeBudgetReady) {
    return { adjusted: null, reason: null };
  }
  return {
    adjusted: buildAssemblyAction({
      availableToolNames: args.availableToolNames,
      contract: args.contract,
      objective: args.objective,
      requestedOutputPath: args.requestedOutputPath
    }),
    reason: "assembly_from_evidence_ready"
  };
}

function injectOutputPathIntoWriterAction(
  action: { tool: string; inputJson: string },
  outputPath: string
): { adjusted: { tool: string; inputJson: string } | null; reason: string | null } {
  if (!DRAFT_TOOL_NAMES.has(action.tool)) {
    return { adjusted: null, reason: null };
  }
  const parsed = safeParseObject(action.inputJson);
  if (!parsed) {
    return { adjusted: null, reason: null };
  }
  if (asString(parsed.outputPath)) {
    return { adjusted: null, reason: null };
  }
  const adjustedInput = {
    ...parsed,
    outputPath
  };
  return {
    adjusted: {
      ...action,
      inputJson: JSON.stringify(adjustedInput)
    },
    reason: "persist_output_path_injected"
  };
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
        "Use iterative reasoning: choose tools, observe output, and replan. Prefer the smallest set of high-yield actions. Respect the specialist objective contract you receive in planner input: do not return actionType=respond until required deliverable criteria are satisfied, unless you explicitly report a failure summary with concrete evidence. When actionType=respond, set responseKind explicitly: use `final` for a completed deliverable, `clarification` only when a new blocker truly requires user input, and `progress` for interim status. Maintain phase progression when drafting or assembly tasks are requested: discovery -> fetch -> synthesis -> persist. If discovery has URLs but fetch is still zero, prioritize downstream transition over repeating search-only cycles. If a synthesis attempt fails but existing evidence is already available, try a revise-style writer pass before triggering fresh retrieval. Each tool includes an `inputContract` in planner context: obey required fields and bounds strictly. For tool actions, always provide valid JSON object input."
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

function slugifyId(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function makeMetadata(entries: Array<[string, AgentMetadataValue | undefined]>): Record<string, AgentMetadataValue> | undefined {
  const next = entries.reduce<Record<string, AgentMetadataValue>>((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});
  return Object.keys(next).length > 0 ? next : undefined;
}

function buildProgressAssumptions(contract: AgentTaskContract, requestedOutputPath: string | null): AgentWorkAssumption[] {
  const assumptions: AgentWorkAssumption[] = [];
  if (contract.requiresDraft) {
    assumptions.push({
      id: "draft-required",
      statement: "The task needs a synthesized draft, not only status updates or raw notes.",
      source: "runtime",
      confidence: "high"
    });
  }
  if (contract.requiresCitations) {
    assumptions.push({
      id: "citations-required",
      statement: `The response should include citation evidence (minimum ${contract.minimumCitationCount}).`,
      source: "runtime",
      confidence: "high"
    });
  }
  if (contract.targetWordCount && contract.targetWordCount > 0) {
    assumptions.push({
      id: "target-word-count",
      statement: `Target draft length is approximately ${contract.targetWordCount} words.`,
      source: "runtime",
      confidence: "medium"
    });
  }
  if (requestedOutputPath) {
    assumptions.push({
      id: "requested-output-path",
      statement: `A persisted artifact is expected at ${requestedOutputPath}.`,
      source: "runtime",
      confidence: "high"
    });
  }
  return assumptions;
}

function buildCandidateSetsFromState(
  context: LeadAgentToolContext,
  progress: SpecialistProgressState
): AgentCandidateSet[] {
  const sets: AgentCandidateSet[] = [];
  const sourceUrlItems: AgentCandidateEntry[] = Array.from(progress.sourceUrls)
    .slice(0, 12)
    .map((url, index) => ({
      id: `candidate-source-url-${index + 1}`,
      label: url,
      summary: "Discovered source candidate available for follow-up retrieval or synthesis support.",
      status: context.getFetchedPages?.().some((page) => page.url === url) ? "supported" : "candidate",
      metadata: makeMetadata([["rank", index + 1]])
    }));
  if (sourceUrlItems.length > 0) {
    sets.push({
      id: "candidate-set-discovered-sources",
      label: "Discovered sources",
      objective: "Potential evidence sources gathered from current task discovery.",
      status: sourceUrlItems.some((item) => item.status === "supported") ? "narrowing" : "open",
      items: sourceUrlItems
    });
  }

  const shortlistedUrls = context.getShortlistedUrls?.() ?? [];
  if (shortlistedUrls.length > 0) {
    const items: AgentCandidateEntry[] = shortlistedUrls.slice(0, 12).map((url, index) => ({
      id: `candidate-url-${index + 1}`,
      label: url,
      summary: "Candidate source discovered for possible follow-up retrieval.",
      status: "candidate",
      metadata: makeMetadata([["rank", index + 1]])
    }));
    sets.push({
      id: "candidate-set-shortlisted-sources",
      label: "Shortlisted sources",
      objective: "Potential source candidates gathered for the current task.",
      status: items.length >= 3 ? "narrowing" : "open",
      items
    });
  }

  if (context.state.leads.length > 0) {
    const items: AgentCandidateEntry[] = context.state.leads.slice(0, 12).map((lead, index) => ({
      id: `candidate-lead-${index + 1}`,
      label: lead.companyName,
      summary: lead.shortDesc,
      status: lead.confidence >= 0.75 ? "supported" : "candidate",
      metadata: makeMetadata([
        ["confidence", Number(lead.confidence.toFixed(3))],
        ["sourceUrl", lead.sourceUrl],
        ["website", lead.website]
      ])
    }));
    sets.push({
      id: "candidate-set-leads",
      label: "Lead candidates",
      objective: "Current candidate entities assembled for lead generation.",
      status: items.length > 0 ? "narrowing" : "open",
      items
    });
  }

  return sets;
}

function buildEvidenceRecordsFromState(context: LeadAgentToolContext): AgentEvidenceRecord[] {
  const records: AgentEvidenceRecord[] = [];
  const sourceCards = context.getResearchSourceCards?.() ?? [];
  for (const [index, card] of sourceCards.slice(-12).entries()) {
    records.push({
      id: `evidence-source-card-${index + 1}`,
      kind: "source_card",
      summary: card.claim,
      source: card.sourceTool === "search" ? "search" : "fetch",
      toolName: card.sourceTool,
      url: card.url,
      confidence: card.quote ? "high" : "medium",
      metadata: makeMetadata([
        ["title", card.title],
        ["date", card.date],
        ["quote", card.quote]
      ])
    });
  }

  for (const [index, page] of (context.getFetchedPages?.() ?? []).slice(-8).entries()) {
    const summary =
      toSourceClaim(page.text, 180)
      || toSourceClaim(page.listItems?.[0] ?? "", 180)
      || toSourceClaim(page.tableRows?.[0] ?? "", 180)
      || "Fetched page available for the current task.";
    records.push({
      id: `evidence-fetched-page-${index + 1}`,
      kind: "fetched_page",
      summary,
      source: "fetch",
      toolName: "web_fetch",
      url: page.url,
      confidence: page.text.length >= 220 ? "medium" : "low",
      metadata: makeMetadata([
        ["title", page.title],
        ["textChars", page.text.length]
      ])
    });
  }

  for (const [index, artifactPath] of context.state.artifacts.slice(-6).entries()) {
    records.push({
      id: `evidence-artifact-${index + 1}`,
      kind: "artifact",
      summary: `Artifact produced at ${artifactPath}.`,
      source: "runtime",
      artifactPath,
      confidence: "high"
    });
  }

  return records;
}

function buildSynthesisState(args: {
  contract: AgentTaskContract;
  requestedOutputPath: string | null;
  progress: SpecialistProgressState;
  thresholds: EvidenceThresholds;
  sourceCardCount: number;
  artifactCount: number;
}): AgentSynthesisState {
  const missingEvidence: string[] = [];
  const completionGaps: string[] = [];
  const requiresReusableBody = args.contract.requiresAssembly === true || args.contract.requiresDraft;
  if (args.progress.fetchedPageCount < args.thresholds.minFetchedPagesForDraft) {
    missingEvidence.push(
      `Fetched evidence is below the current threshold (${args.progress.fetchedPageCount}/${args.thresholds.minFetchedPagesForDraft} pages).`
    );
  }
  if (args.sourceCardCount < args.thresholds.minSourceCardsForDraft) {
    missingEvidence.push(
      `Structured evidence coverage is below the current threshold (${args.sourceCardCount}/${args.thresholds.minSourceCardsForDraft} source cards).`
    );
  }
  if (requiresReusableBody && args.progress.lastWriterOutputAvailability !== "body_available") {
    completionGaps.push("A reusable synthesized body has not been produced yet.");
  }
  if (args.contract.requiresCitations && args.progress.citationCount < args.contract.minimumCitationCount) {
    completionGaps.push(
      `Citation coverage is below the task minimum (${args.progress.citationCount}/${args.contract.minimumCitationCount}).`
    );
  }
  if (args.requestedOutputPath && args.artifactCount === 0) {
    completionGaps.push("The requested persisted artifact has not been written yet.");
  }

  const readyForSynthesis = missingEvidence.length === 0;

  let status: AgentSynthesisState["status"] = "not_ready";
  if (
    readyForSynthesis
    && completionGaps.length === 0
    && (
      args.progress.lastWriterOutputAvailability === "body_available"
      || (!requiresReusableBody && args.progress.draftWordCount > 0)
      || !requiresReusableBody
    )
  ) {
    status = args.artifactCount > 0 || !args.requestedOutputPath ? "complete" : "partial";
  } else if (readyForSynthesis) {
    status = "ready";
  } else if (args.progress.sourceUrls.size > 0 || args.progress.fetchedPageCount > 0 || args.sourceCardCount > 0) {
    status = "emerging";
  }

  const summary =
    status === "complete"
      ? "Runtime evidence indicates the task output has been synthesized and persisted."
      : status === "ready"
        ? "Runtime evidence indicates a synthesis pass can proceed without reopening discovery."
        : status === "emerging"
          ? "Evidence is accumulating, but synthesis is still gated by missing support."
          : "The current task does not yet have enough supporting work to synthesize confidently.";

  return {
    status,
    summary,
    missingEvidence,
    completionGaps,
    readyForSynthesis,
    metadata: makeMetadata([
      ["sourceUrlCount", args.progress.sourceUrls.size],
      ["fetchedPageCount", args.progress.fetchedPageCount],
      ["sourceCardCount", args.sourceCardCount],
      ["draftWordCount", args.progress.draftWordCount],
      ["artifactCount", args.artifactCount],
      ["lastWriterOutputAvailability", args.progress.lastWriterOutputAvailability]
    ])
  };
}

function deriveActiveWorkState(args: {
  objective: string;
  contract: AgentTaskContract;
  requestedOutputPath: string | null;
  currentPhase: SpecialistPhase;
  progress: SpecialistProgressState;
  context: LeadAgentToolContext;
  thresholds: EvidenceThresholds;
}): ActiveWorkStateSnapshot {
  const assumptions = buildProgressAssumptions(args.contract, args.requestedOutputPath);
  const candidateSets = buildCandidateSetsFromState(args.context, args.progress);
  const evidenceRecords = buildEvidenceRecordsFromState(args.context);
  const sourceCardCount = args.context.getResearchSourceCards?.().length ?? 0;
  const synthesisState = buildSynthesisState({
    contract: args.contract,
    requestedOutputPath: args.requestedOutputPath,
    progress: args.progress,
    thresholds: args.thresholds,
    sourceCardCount,
    artifactCount: args.context.state.artifacts.length
  });
  const unresolvedItems = [...synthesisState.missingEvidence, ...(synthesisState.completionGaps ?? [])].slice(0, 8);
  const mainTaskId = `task-${slugifyId(args.objective, "current-objective")}`;
  const activeWorkItems: AgentActiveWorkItem[] = [
    {
      id: mainTaskId,
      kind: "task",
      label: "Current delegated objective",
      summary: args.contract.requiredDeliverable,
      status:
        synthesisState.status === "complete"
          ? "completed"
          : synthesisState.readyForSynthesis
            ? "ready"
            : "active",
      candidateSetIds: candidateSets.map((set) => set.id),
      evidenceRecordIds: evidenceRecords.slice(-8).map((record) => record.id),
      metadata: makeMetadata([
        ["phase", args.currentPhase],
        ["requiresDraft", args.contract.requiresDraft],
        ["requiresCitations", args.contract.requiresCitations],
        ["requestedOutputPath", args.requestedOutputPath]
      ])
    }
  ];

  if (evidenceRecords.length > 0) {
    activeWorkItems.push({
      id: "evidence-assembly",
      kind: "evidence",
      label: "Evidence assembly",
      summary: "Collected evidence supporting the current task.",
      status: synthesisState.readyForSynthesis ? "ready" : "active",
      evidenceRecordIds: evidenceRecords.slice(-12).map((record) => record.id),
      metadata: makeMetadata([
        ["recordCount", evidenceRecords.length],
        ["sourceCardCount", sourceCardCount]
      ])
    });
  }

  if (args.contract.requiresDraft) {
    activeWorkItems.push({
      id: "draft-synthesis",
      kind: "draft",
      label: "Draft synthesis",
      summary: synthesisState.summary,
      status:
        synthesisState.status === "complete"
          ? "completed"
          : synthesisState.readyForSynthesis
            ? "ready"
            : "blocked",
      evidenceRecordIds: evidenceRecords.slice(-8).map((record) => record.id),
      metadata: makeMetadata([
        ["draftWordCount", args.progress.draftWordCount],
        ["citationCount", args.progress.citationCount]
      ])
    });
  }

  return {
    assumptions,
    unresolvedItems,
    activeWorkItems,
    candidateSets,
    evidenceRecords,
    synthesisState
  };
}

function hydrateToolContextWorkState(context: LeadAgentToolContext, snapshot: ActiveWorkStateSnapshot): void {
  context.setAssumptions?.(snapshot.assumptions);
  context.setUnresolvedItems?.(snapshot.unresolvedItems);
  context.setActiveWorkItems?.(snapshot.activeWorkItems);
  context.setCandidateSets?.(snapshot.candidateSets);
  context.setEvidenceRecords?.(snapshot.evidenceRecords);
  context.setSynthesisState?.(snapshot.synthesisState);
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
  if (tool === "writer_agent" || tool === "article_writer") {
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

function buildSpecialistTaskContract(options: Pick<SpecialistToolLoopOptions, "skillName" | "message">): AgentTaskContract {
  const normalized = options.message.toLowerCase();
  const isResearchSkill = options.skillName === "research_agent";
  const requiresDraft = isResearchSkill && /\b(blog|post|article|draft|write)\b/.test(normalized);
  const requiresCitations = isResearchSkill && /\b(cite|cited|citations?|sources?)\b/.test(normalized);
  const minimumCitationCount = requiresCitations ? 2 : 0;
  const targetWordCount = (() => {
    const rangeMatch = options.message.match(/\b(\d{2,4})\s*[-–]\s*(\d{2,4})\s*words?\b/i);
    if (rangeMatch?.[1] && rangeMatch?.[2]) {
      const lower = Number.parseInt(rangeMatch[1], 10);
      const upper = Number.parseInt(rangeMatch[2], 10);
      if (Number.isFinite(lower) && Number.isFinite(upper) && lower > 0 && upper > 0) {
        return Math.round((lower + upper) / 2);
      }
    }
    const singleMatch = options.message.match(/\b(\d{2,4})\s*words?\b/i);
    if (singleMatch?.[1]) {
      const parsed = Number.parseInt(singleMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return null;
  })();
  const requestedOutputPath = extractOutputPathFromObjective(options.message);

  if (isResearchSkill) {
    return {
      requiredDeliverable: requiresDraft
        ? "Produce a complete research-backed draft response."
        : "Produce a concise research synthesis response.",
      requiresAssembly: true,
      requiresDraft,
      requiresCitations,
      minimumCitationCount,
      doneCriteria: [
        "Gather source evidence from search/fetch outputs.",
        requiresDraft ? "Return full draft text (not only status)." : "Return synthesized findings.",
        requiresCitations ? `Include at least ${minimumCitationCount} citation links.` : "Citations preferred when available."
      ],
      requestedOutputPath,
      targetWordCount,
      clarificationAllowed: false
    };
  }

  return {
    requiredDeliverable: "Return a complete specialist response for the current objective.",
    requiresAssembly: false,
    requiresDraft: false,
    requiresCitations: false,
    minimumCitationCount: 0,
    doneCriteria: ["Return a complete response for the delegated objective."],
    requestedOutputPath,
    targetWordCount,
    clarificationAllowed: true
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
    errorSamples: [],
    lastWriterOutputAvailability: null,
    lastWriterDeliverableStatus: null,
    lastWriterProcessCommentaryDetected: false
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
    const pagesFetched =
      typeof payload.usablePageCount === "number"
        ? payload.usablePageCount
        : (typeof payload.pagesFetched === "number" ? payload.pagesFetched : 0);
    progress.fetchedPageCount += Math.max(0, pagesFetched);
  }

  if (DRAFT_TOOL_NAMES.has(result.tool)) {
    const content = typeof payload.content === "string" ? payload.content : "";
    const draftQuality = typeof payload.draftQuality === "string" ? payload.draftQuality : undefined;
    const fallbackUsed = payload.fallbackUsed === true;
    const deliverableStatus =
      payload.deliverableStatus === "complete" || payload.deliverableStatus === "partial" || payload.deliverableStatus === "insufficient"
        ? payload.deliverableStatus
        : null;
    const processCommentaryDetected = payload.processCommentaryDetected === true;
    const outputAvailability = deriveWriterResultOutputAvailability(payload);
    progress.lastWriterOutputAvailability = outputAvailability;
    progress.lastWriterDeliverableStatus = deliverableStatus;
    progress.lastWriterProcessCommentaryDetected = processCommentaryDetected;
    const shouldCountDraftProgress =
      outputAvailability === "body_available" && (draftQuality === "complete" || (!draftQuality && !fallbackUsed));
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
  contract: AgentTaskContract,
  progress: SpecialistProgressState,
  artifactCount: number
): SpecialistPhaseTransitionHint {
  const requiresAssembly = contract.requiresAssembly === true || contract.requiresDraft || contract.requiresCitations;
  if (!requiresAssembly) {
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

function deriveSpecialistOutputAvailability(args: {
  contract: AgentTaskContract;
  progress: SpecialistProgressState;
  responseText: string | null;
  activeWorkState: ActiveWorkStateSnapshot;
  artifactCount: number;
}): SessionOutputAvailability {
  if (args.progress.lastWriterOutputAvailability) {
    return args.progress.lastWriterOutputAvailability;
  }
  if (args.artifactCount > 0) {
    return args.contract.requiresAssembly === true || args.contract.requiresDraft || args.contract.requiresCitations
      ? "metadata_only"
      : "body_available";
  }
  const responseWords = countWords(args.responseText ?? "");
  const draftWords = Math.max(args.progress.draftWordCount, responseWords);
  if (args.contract.requiresDraft || args.contract.requiresAssembly === true) {
    if (draftWords >= 180) {
      return "body_available";
    }
  } else if (responseWords >= 80) {
    return "body_available";
  }
  const hasRecoverableMetadata =
    args.activeWorkState.evidenceRecords.length > 0
    || args.progress.sourceUrls.size > 0
    || args.progress.fetchedPageCount > 0
    || (args.activeWorkState.unresolvedItems.length > 0 && draftWords > 0);
  return hasRecoverableMetadata ? "metadata_only" : "missing";
}

function evaluateSpecialistContractGate(args: {
  contract: AgentTaskContract;
  progress: SpecialistProgressState;
  responseText: string | null;
  activeWorkState: ActiveWorkStateSnapshot;
}): { satisfied: boolean; unmet: string[] } {
  const unmet: string[] = [];
  const responseWords = countWords(args.responseText ?? "");
  const responseCitationCount = extractUrls(args.responseText ?? "").length;
  const outputAvailability = deriveSpecialistOutputAvailability({
    contract: args.contract,
    progress: args.progress,
    responseText: args.responseText,
    activeWorkState: args.activeWorkState,
    artifactCount: 0
  });
  const hasAnyEvidence =
    args.activeWorkState.evidenceRecords.length > 0
    || args.progress.sourceUrls.size > 0
    || args.progress.fetchedPageCount > 0;

  if ((args.contract.requiresDraft || args.contract.requiresCitations) && !hasAnyEvidence) {
    unmet.push("supporting_evidence_missing");
  }
  if (args.contract.requiresDraft) {
    const hasDraft = args.progress.draftWordCount >= 120 || responseWords >= 180;
    if (!hasDraft) {
      unmet.push("draft_text_missing");
    }
    if (
      responseWords >= 180 &&
      args.progress.draftWordCount === 0 &&
      !args.activeWorkState.synthesisState.readyForSynthesis
    ) {
      unmet.push("synthesis_not_ready");
    }
    if (outputAvailability !== "body_available") {
      unmet.push("output_body_unavailable");
    }
  }
  if (args.contract.requiresAssembly === true && outputAvailability !== "body_available") {
    if (hasAnyEvidence) {
      unmet.push("output_body_unavailable");
    }
  }
  if (args.contract.requiresCitations) {
    const citationCount = Math.max(args.progress.citationCount, responseCitationCount);
    if (citationCount < args.contract.minimumCitationCount) {
      unmet.push("citation_evidence_missing");
    }
  }
  if ((args.contract.requiresDraft || args.contract.requiresCitations) && responseWords < 180 && args.activeWorkState.unresolvedItems.length > 0) {
    unmet.push("active_work_unresolved");
  }
  return {
    satisfied: Array.from(new Set(unmet)).length === 0,
    unmet: Array.from(new Set(unmet))
  };
}

function buildResearchFailureSummary(args: {
  progress: SpecialistProgressState;
  observations: Array<{ iteration: number; summary: string }>;
  artifactCount: number;
  partialResultReturned: boolean;
  activeWorkState: ActiveWorkStateSnapshot;
  outputAvailability: SessionOutputAvailability;
}): string {
  const progress = args.progress;
  const observations = args.observations;
  const recent = observations.slice(-4).map((item) => `iter ${item.iteration}: ${item.summary}`).join(" | ");
  const errors = progress.errorSamples.length > 0 ? progress.errorSamples.join(" | ") : "none";
  const unresolved = args.activeWorkState.unresolvedItems.slice(0, 4).join(" | ") || "none";
  return [
    args.outputAvailability === "body_available"
      ? "I reached guardrails, so I am returning the best reusable body collected so far."
      : args.outputAvailability === "metadata_only"
        ? "I reached guardrails with recoverable research metadata, but not a reusable final body."
        : "I couldn't finish a publish-ready draft within this run budget.",
    `Progress so far: ${progress.sourceUrls.size} sources discovered, ${progress.fetchedPageCount} pages fetched, ${progress.draftWordCount} draft words, ${progress.citationCount} citations.`,
    `Output availability: ${args.outputAvailability}.`,
    `Synthesis state: ${args.activeWorkState.synthesisState.status}. ${args.activeWorkState.synthesisState.summary}`,
    (args.activeWorkState.synthesisState.completionGaps?.length ?? 0) > 0
      ? `Completion gaps: ${args.activeWorkState.synthesisState.completionGaps?.slice(0, 4).join(" | ")}.`
      : null,
    args.artifactCount > 0 ? `Artifacts currently available: ${args.artifactCount}.` : "No artifacts were produced yet.",
    `Unresolved work: ${unresolved}.`,
    `Most recent blockers: ${errors}.`,
    `Recent loop notes: ${recent || "none"}.`
  ].filter(Boolean).join(" ");
}

function createToolContext(options: SpecialistToolLoopOptions, deadlineAtMs: number): LeadAgentToolContext {
  const initialSynthesisState: AgentSynthesisState = {
    status: "not_ready",
    summary: "No active synthesis state yet.",
    missingEvidence: [],
    readyForSynthesis: false
  };
  const state: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: options.leadExecutionBrief?.requestedLeadCount ?? 0,
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
    llmProviders: options.llmProviders,
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
    getResearchSourceCards: () => state.researchSourceCards ?? [],
    setAssumptions: (assumptions) => {
      state.assumptions = assumptions;
    },
    getAssumptions: () => state.assumptions ?? [],
    setUnresolvedItems: (items) => {
      state.unresolvedItems = items;
    },
    getUnresolvedItems: () => state.unresolvedItems ?? [],
    setActiveWorkItems: (items) => {
      state.activeWorkItems = items;
    },
    getActiveWorkItems: () => state.activeWorkItems ?? [],
    setCandidateSets: (sets) => {
      state.candidateSets = sets;
    },
    getCandidateSets: () => state.candidateSets ?? [],
    setEvidenceRecords: (records) => {
      state.evidenceRecords = records;
    },
    getEvidenceRecords: () => state.evidenceRecords ?? [],
    setSynthesisState: (synthesisState) => {
      state.synthesisState = synthesisState;
    },
    getSynthesisState: () => state.synthesisState
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
  const taskContract = options.taskContract ?? buildSpecialistTaskContract(options);
  const requestedOutputPath = taskContract.requestedOutputPath ?? extractOutputPathFromObjective(options.message);
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
  let draftFailureStreak = 0;
  let lastDraftAttemptEvidence: EvidenceSnapshot | null = null;
  let pendingMechanicalRecoveryActions: Array<{ tool: string; inputJson: string }> | null = null;
  let pendingMechanicalRecoveryReason: string | null = null;

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
    const remainingMs = Math.max(0, deadlineAtMs - Date.now());
    const currentPhase = deriveSpecialistPhase(taskContract, progress, toolContext.state.artifacts.length);
    const phaseTransitionHint = derivePhaseTransitionHint(taskContract, progress, toolContext.state.artifacts.length);
    const retryProfile = buildSearchRetryProfile(progress, consecutiveSearchOnlyIterations);
    const expectedToolFamily = expectedPhaseToolFamily(currentPhase, options.skillName);
    const sourceCardCount = toolContext.getResearchSourceCards?.().length ?? 0;
    const evidenceThresholds = deriveEvidenceThresholds(taskContract);
    const activeWorkState = deriveActiveWorkState({
      objective: options.message,
      contract: taskContract,
      requestedOutputPath,
      currentPhase,
      progress,
      context: toolContext,
      thresholds: evidenceThresholds
    });
    hydrateToolContextWorkState(toolContext, activeWorkState);
    const writerReadiness = assessWriterReadiness({
      contract: taskContract,
      thresholds: evidenceThresholds,
      progress,
      sourceCardCount,
      synthesisState: activeWorkState.synthesisState,
      remainingMs
    });
    const currentEvidenceSnapshot: EvidenceSnapshot = {
      sourceUrlCount: progress.sourceUrls.size,
      fetchedPageCount: progress.fetchedPageCount,
      sourceCardCount
    };
    const evidenceAdvancedSinceLastDraft = hasEvidenceAdvanced(currentEvidenceSnapshot, lastDraftAttemptEvidence);

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

    const plannerDiagnostic = pendingMechanicalRecoveryActions
      ? null
      : await structuredChatRunner(
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
              remainingMs,
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
              evidenceState: {
                sourceCardCount,
                draftEvidenceReady:
                  progress.fetchedPageCount >= evidenceThresholds.minFetchedPagesForDraft
                  && sourceCardCount >= evidenceThresholds.minSourceCardsForDraft,
                minimumForDraft: {
                  fetchedPages: evidenceThresholds.minFetchedPagesForDraft,
                  sourceCards: evidenceThresholds.minSourceCardsForDraft
                }
              },
              researchScratchpad: {
                sourceCardCount,
                sampleSourceCards: (toolContext.getResearchSourceCards?.() ?? [])
                  .slice(-5)
                  .map((card) => ({
                    url: card.url,
                    title: card.title,
                    date: card.date,
                    claim: card.claim
                  }))
              },
              activeWorkState: {
                assumptions: activeWorkState.assumptions,
                unresolvedItems: activeWorkState.unresolvedItems,
                activeWorkItems: activeWorkState.activeWorkItems,
                candidateSets: activeWorkState.candidateSets.map((set) => ({
                  id: set.id,
                  label: set.label,
                  status: set.status,
                  objective: set.objective,
                  itemCount: set.items.length,
                  sampleItems: set.items.slice(0, 5)
                })),
                evidenceRecords: activeWorkState.evidenceRecords.slice(-8),
                synthesisState: activeWorkState.synthesisState
              },
              writerReadiness,
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
              writerRetryState: {
                draftFailureStreak,
                evidenceAdvancedSinceLastDraft
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

    let plan: SpecialistPlannerOutput | null = null;
    if (plannerDiagnostic) {
      plannerCallsUsed += 1;
    }
    if (plannerDiagnostic?.usage) {
      await options.runStore.addLlmUsage(options.runId, plannerDiagnostic.usage, 1);
    }
    if (!plannerDiagnostic?.result) {
      if (pendingMechanicalRecoveryActions) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: pendingMechanicalRecoveryReason ?? "planner_failure_recovery",
            phaseTransitionHint,
            adjustedActionCount: pendingMechanicalRecoveryActions.length
          },
          timestamp: nowIso()
        });
      } else {
        consecutivePlannerFailures += 1;
        const failureClass = plannerDiagnostic?.failureClass ?? classifyStructuredFailure(plannerDiagnostic ?? {});
        const failureMessage = plannerDiagnostic?.failureMessage?.slice(0, 220) ?? "planner_failed";
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "observe",
          eventType: "specialist_planner_failed",
          payload: {
            skillName: options.skillName,
            iteration,
            failureClass,
            failureCode: plannerDiagnostic?.failureCode ?? "unknown",
            attempts: plannerDiagnostic?.attempts ?? 1,
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
          const recoveryActions = phaseTransitionHint === "discovery_complete_fetch_pending"
            ? buildEvidenceRecoveryAction(new Set(Array.from(availableTools.keys())), options.message, progress.sourceUrls)
            : null;
          if (recoveryActions && recoveryActions.length > 0) {
            pendingMechanicalRecoveryActions = recoveryActions;
            pendingMechanicalRecoveryReason = "planner_failure_fetch_recovery";
            consecutivePlannerFailures = 0;
            continue;
          }
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
    } else {
      consecutivePlannerFailures = 0;
      plan = plannerDiagnostic.result;
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
          responseKind: plan.responseKind ?? null,
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
    }

    let forcedActionsFromRespond: Array<{ tool: string; inputJson: string }> | null = null;
    if (plan?.actionType === "respond") {
      if (plan.responseKind === "clarification" && taskContract.clarificationAllowed !== true) {
        const assemblyActions = buildAssemblyAction({
          availableToolNames: new Set(Array.from(availableTools.keys())),
          contract: taskContract,
          objective: options.message,
          requestedOutputPath
        });
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: assemblyActions ? "specialist_clarification_locked" : "specialist_clarification_blocked",
            responseKind: plan.responseKind,
            synthesisReady: activeWorkState.synthesisState.readyForSynthesis
          },
          timestamp: nowIso()
        });
        if (assemblyActions && activeWorkState.synthesisState.readyForSynthesis) {
          forcedActionsFromRespond = assemblyActions;
        } else {
          observations.push({
            iteration,
            summary: "clarification_blocked_by_contract"
          });
          continue;
        }
      }
    }

    if (plan?.actionType === "respond" && !forcedActionsFromRespond) {
      const contractGate = evaluateSpecialistContractGate({
        contract: taskContract,
        progress,
        responseText: plan.responseText,
        activeWorkState
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
            },
            activeWorkState: {
              unresolvedItems: activeWorkState.unresolvedItems,
              evidenceRecordCount: activeWorkState.evidenceRecords.length,
              synthesisState: activeWorkState.synthesisState,
              outputAvailability: deriveSpecialistOutputAvailability({
                contract: taskContract,
                progress,
                responseText: plan.responseText,
                activeWorkState,
                artifactCount: toolContext.state.artifacts.length
              })
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
      plan?.actionType === "single" && plan.singleTool
        ? defaultToolInputJson(plan.singleTool, options.message)
        : null;
    const shouldDefaultSingleInput =
      plan?.actionType === "single" &&
      Boolean(plan.singleTool) &&
      (
        !plan.singleInputJson ||
        !safeParseObject(plan.singleInputJson)
      ) &&
      Boolean(singleActionDefaultInput);

    const requestedActions = pendingMechanicalRecoveryActions
      ? pendingMechanicalRecoveryActions
      : forcedActionsFromRespond
      ? forcedActionsFromRespond
      : (
      plan?.actionType === "single"
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
        : (plan?.parallelActions ?? [])
      );

    let actions = requestedActions
      .map((action) => ({
        tool: action.tool.trim(),
        inputJson: action.inputJson
      }))
      .filter((action) => action.tool.length > 0 && typeof action.inputJson === "string" && action.inputJson.trim().length > 0)
      .slice(0, Math.max(1, options.maxParallelTools));

    if (
      plan?.actionType === "single" &&
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
      const evidenceGap = shouldApplyEvidenceGapGuard({
        contract: taskContract,
        actions,
        availableToolNames: new Set(Array.from(availableTools.keys())),
        objective: options.message
        ,
        progress,
        writerReadiness,
        thresholds: evidenceThresholds,
        sourceCardCount
      });
      if (evidenceGap.adjusted && evidenceGap.adjusted.length > 0) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: evidenceGap.reason,
            detail: evidenceGap.detail,
            originalActionCount: actions.length,
            adjustedActionCount: evidenceGap.adjusted.length
          },
          timestamp: nowIso()
        });
        actions = evidenceGap.adjusted;
      }
    }

    if (actions.length > 0) {
      const retryGuard = shouldApplyWriterRetryBudgetGuard({
        actions,
        draftFailureStreak,
        evidenceAdvancedSinceLastDraft,
        availableToolNames: new Set(Array.from(availableTools.keys())),
        progress,
        objective: options.message,
        writerReadiness,
        sourceCardCount
      });
      if (retryGuard.adjusted && retryGuard.adjusted.length > 0) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: retryGuard.reason,
            detail: retryGuard.detail,
            originalActionCount: actions.length,
            adjustedActionCount: retryGuard.adjusted.length
          },
          timestamp: nowIso()
        });
        actions = retryGuard.adjusted;
      }
    }

    if (actions.length > 0) {
      const assemblyGuard = shouldApplyAssemblyGuard({
        skillName: options.skillName,
        phase: currentPhase,
        actions,
        availableToolNames: new Set(Array.from(availableTools.keys())),
        objective: options.message,
        contract: taskContract,
        requestedOutputPath,
        writerReadiness
      });
      if (assemblyGuard.adjusted && assemblyGuard.adjusted.length > 0) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: assemblyGuard.reason,
            originalActionCount: actions.length,
            adjustedActionCount: assemblyGuard.adjusted.length
          },
          timestamp: nowIso()
        });
        actions = assemblyGuard.adjusted;
      }
    }

    if (actions.length > 0) {
      const lowBudgetFinalizeGuard = shouldApplyLowBudgetFinalizeGuard({
        skillName: options.skillName,
        remainingMs,
        actions,
        availableToolNames: new Set(Array.from(availableTools.keys())),
        objective: options.message,
        requestedOutputPath,
        targetWordCount: taskContract.targetWordCount ?? null,
        progress,
        sourceCardCount,
        writerReadiness
      });
      if (lowBudgetFinalizeGuard.adjusted && lowBudgetFinalizeGuard.adjusted.length > 0) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_plan_adjusted",
          payload: {
            skillName: options.skillName,
            iteration,
            reason: lowBudgetFinalizeGuard.reason,
            detail: lowBudgetFinalizeGuard.detail,
            originalActionCount: actions.length,
            adjustedActionCount: lowBudgetFinalizeGuard.adjusted.length
          },
          timestamp: nowIso()
        });
        actions = lowBudgetFinalizeGuard.adjusted;
      }
    }

    if (actions.length > 0) {
      if (requestedOutputPath) {
        let adjustedCount = 0;
        const adjustedActions = actions.map((action) => {
          const injected = injectOutputPathIntoWriterAction(action, requestedOutputPath);
          if (injected.adjusted) {
            adjustedCount += 1;
            return injected.adjusted;
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
              reason: "persist_output_path_injected",
              outputPath: requestedOutputPath,
              adjustedCount
            },
            timestamp: nowIso()
          });
          actions = adjustedActions;
        }
      }
    }

    if (actions.length > 0) {
      const phaseLock = shouldForcePhaseTransition({
        contract: taskContract,
        progress,
        actions,
        availableToolNames: new Set(Array.from(availableTools.keys())),
        objective: options.message,
        currentPhase,
        phaseTransitionHint
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
      pendingMechanicalRecoveryActions = null;
      pendingMechanicalRecoveryReason = null;
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
      if (DRAFT_TOOL_NAMES.has(execution.tool)) {
        lastDraftAttemptEvidence = {
          sourceUrlCount: progress.sourceUrls.size,
          fetchedPageCount: progress.fetchedPageCount,
          sourceCardCount: toolContext.getResearchSourceCards?.().length ?? 0
        };
        if (execution.status === "error") {
          draftFailureStreak += 1;
        } else {
          const payload = execution.result ?? {};
          const draftQuality = typeof payload.draftQuality === "string" ? payload.draftQuality : "unknown";
          if (draftQuality === "complete") {
            draftFailureStreak = 0;
          } else {
            draftFailureStreak += 1;
          }
        }
      }
    }
    const afterSnapshot = captureProgressSnapshot(progress, toolContext.state.artifacts.length);
    const postActionActiveWorkState = deriveActiveWorkState({
      objective: options.message,
      contract: taskContract,
      requestedOutputPath,
      currentPhase: deriveSpecialistPhase(taskContract, progress, toolContext.state.artifacts.length),
      progress,
      context: toolContext,
      thresholds: evidenceThresholds
    });
    hydrateToolContextWorkState(toolContext, postActionActiveWorkState);
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
    pendingMechanicalRecoveryActions = null;
    pendingMechanicalRecoveryReason = null;

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "observe",
      eventType: "specialist_action_result",
        payload: {
          skillName: options.skillName,
          iteration,
          summary,
          activeWorkState: {
            assumptions: postActionActiveWorkState.assumptions,
            unresolvedItems: postActionActiveWorkState.unresolvedItems,
            activeWorkItems: postActionActiveWorkState.activeWorkItems,
            candidateSetCount: postActionActiveWorkState.candidateSets.length,
            evidenceRecordCount: postActionActiveWorkState.evidenceRecords.length,
            synthesisState: postActionActiveWorkState.synthesisState
          },
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
    if (draftFailureStreak >= 3 && !evidenceAdvancedSinceLastDraft) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "specialist_loop_guard_triggered",
        payload: {
          skillName: options.skillName,
          guard: "writer_retry_budget_exhausted",
          draftFailureStreak,
          evidenceAdvancedSinceLastDraft
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

  const finalThresholds = deriveEvidenceThresholds(taskContract);
  const finalActiveWorkState = deriveActiveWorkState({
    objective: options.message,
    contract: taskContract,
    requestedOutputPath,
    currentPhase: deriveSpecialistPhase(taskContract, progress, toolContext.state.artifacts.length),
    progress,
    context: toolContext,
    thresholds: finalThresholds
  });
  const unmetContract = evaluateSpecialistContractGate({
    contract: taskContract,
    progress,
    responseText: null,
    activeWorkState: finalActiveWorkState
  });
  const outputAvailability = deriveSpecialistOutputAvailability({
    contract: taskContract,
    progress,
    responseText: null,
    activeWorkState: finalActiveWorkState,
    artifactCount: toolContext.state.artifacts.length
  });
  const partialResultReturned =
    options.skillName === "research_agent" && outputAvailability !== "missing";
  const assistantText =
    options.skillName === "research_agent" && !unmetContract.satisfied
      ? buildResearchFailureSummary({
          progress,
          observations,
          artifactCount: toolContext.state.artifacts.length,
          partialResultReturned,
          activeWorkState: finalActiveWorkState,
          outputAvailability
        })
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
      partialResultReturned,
      plannerCallsUsed,
      toolCallsUsed,
      searchTimeoutCount: progress.searchTimeoutCount,
      sourceUrlCount: progress.sourceUrls.size,
      fetchedPageCount: progress.fetchedPageCount,
      outputAvailability,
      unmetContract: unmetContract.unmet,
      activeWorkState: {
        unresolvedItems: finalActiveWorkState.unresolvedItems,
        evidenceRecordCount: finalActiveWorkState.evidenceRecords.length,
        synthesisState: finalActiveWorkState.synthesisState
      }
    },
    timestamp: nowIso()
  });

  return {
    status: "completed",
    assistantText,
    artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
  };
}
