import { z } from "zod";
import type { PolicyMode, RunOutcome, RunRecord, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import * as openAiClient from "../services/openAiClient.js";
import { composeSystemPrompt } from "../prompts/composePrompt.js";
import { ALFRED_MASTER_PROMPT_VERSION, ALFRED_MASTER_SYSTEM_PROMPT } from "../prompts/master/alfred.system.js";
import type { LeadAgentRuntimeOptions } from "./runLeadAgenticLoop.js";
import { runAgentLoop } from "./runAgentLoop.js";
import { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import type { LeadAgentDefaults, LeadAgentState, LeadAgentToolContext } from "../agent/types.js";
import { applyToolAllowlist, discoverLeadAgentTools } from "../agent/tools/registry.js";
import { resolveLeadAgentToolAllowlist } from "../agent/toolPolicies.js";
import { redactValue } from "../utils/redact.js";
import { listAgentSkills } from "../agent/skills/registry.js";
import { LeadExecutionBriefSchema, type LeadExecutionBrief } from "../tools/lead/schemas.js";
import { parseRequestedLeadCount } from "../tools/lead/requestIntent.js";

interface AlfredOrchestratorOptions {
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
  policyMode: PolicyMode;
  sessionContext?: SessionPromptContext;
  isCancellationRequested: () => Promise<boolean>;
  structuredChatRunner?: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
  agentLoopRunner?: typeof runAgentLoop;
}

interface AlfredPlannerOutput {
  thought: string;
  actionType: "delegate_agent" | "call_tool" | "respond";
  delegateAgent: string | null;
  delegateBrief: string | null;
  toolName: string | null;
  toolInputJson: string | null;
  responseText: string | null;
}

interface AlfredCompletionEvaluation {
  thought: string;
  shouldRespond: boolean;
  responseText: string | null;
  continueReason: string | null;
  confidence: number;
}

interface AlfredLeadBriefOutput {
  thought: string;
  requestedLeadCount: number;
  emailRequired: boolean;
  outputFormat: string | null;
  objectiveBrief: LeadExecutionBrief["objectiveBrief"];
}

type AlfredTaskType = "lead_generation" | "general";

interface AlfredActionSnapshot {
  iteration: number;
  actionType: "delegate_agent" | "call_tool" | "respond" | "system";
  name: string;
  status: "planned" | "completed" | "failed" | "cancelled";
  summary: string;
}

interface AlfredTurnState {
  turnObjective: string;
  taskType: AlfredTaskType;
  canonicalLeadBrief: LeadExecutionBrief | null;
  completionCriteria: string[];
  completedCriteria: string[];
  missingRequirements: string[];
  blockingIssues: string[];
  facts: {
    requestedLeadCount: number | null;
    collectedLeadCount: number;
    collectedEmailCount: number;
    artifactCount: number;
    fetchedPageCount: number;
    shortlistedUrlCount: number;
    outputFormat: string | null;
  };
  lastAction: AlfredActionSnapshot | null;
}

const ALFRED_PLANNER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    actionType: { type: "string", enum: ["delegate_agent", "call_tool", "respond"] },
    delegateAgent: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    delegateBrief: { anyOf: [{ type: "string", minLength: 1, maxLength: 1200 }, { type: "null" }] },
    toolName: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    toolInputJson: { anyOf: [{ type: "string", minLength: 2, maxLength: 1200 }, { type: "null" }] },
    responseText: { anyOf: [{ type: "string", minLength: 1, maxLength: 4000 }, { type: "null" }] }
  },
  required: ["thought", "actionType", "delegateAgent", "delegateBrief", "toolName", "toolInputJson", "responseText"]
} as const;

const AlfredPlannerOutputSchema: z.ZodType<AlfredPlannerOutput> = z.object({
  thought: z.string().min(1).max(500),
  actionType: z.enum(["delegate_agent", "call_tool", "respond"]),
  delegateAgent: z.string().min(1).max(80).nullable(),
  delegateBrief: z.string().min(1).max(1200).nullable(),
  toolName: z.string().min(1).max(80).nullable(),
  toolInputJson: z.string().min(2).max(1200).nullable(),
  responseText: z.string().min(1).max(4000).nullable()
});

const ALFRED_COMPLETION_EVALUATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    shouldRespond: { type: "boolean" },
    responseText: { anyOf: [{ type: "string", minLength: 1, maxLength: 4000 }, { type: "null" }] },
    continueReason: { anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["thought", "shouldRespond", "responseText", "continueReason", "confidence"]
} as const;

const AlfredCompletionEvaluationSchema: z.ZodType<AlfredCompletionEvaluation> = z.object({
  thought: z.string().min(1).max(500),
  shouldRespond: z.boolean(),
  responseText: z.string().min(1).max(4000).nullable(),
  continueReason: z.string().min(1).max(500).nullable(),
  confidence: z.number().min(0).max(1)
});

const ALFRED_LEAD_BRIEF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    requestedLeadCount: { type: "integer", minimum: 1, maximum: 100 },
    emailRequired: { type: "boolean" },
    outputFormat: { anyOf: [{ type: "string", minLength: 2, maxLength: 80 }, { type: "null" }] },
    objectiveBrief: {
      type: "object",
      additionalProperties: false,
      properties: {
        objectiveSummary: { type: "string", minLength: 8, maxLength: 400 },
        companyType: { anyOf: [{ type: "string", minLength: 2, maxLength: 160 }, { type: "null" }] },
        industry: { anyOf: [{ type: "string", minLength: 2, maxLength: 160 }, { type: "null" }] },
        geography: { anyOf: [{ type: "string", minLength: 2, maxLength: 160 }, { type: "null" }] },
        businessModel: { anyOf: [{ type: "string", minLength: 2, maxLength: 80 }, { type: "null" }] },
        contactRequirement: { anyOf: [{ type: "string", minLength: 2, maxLength: 160 }, { type: "null" }] },
        constraintsMissing: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 2, maxLength: 80 }
        }
      },
      required: [
        "objectiveSummary",
        "companyType",
        "industry",
        "geography",
        "businessModel",
        "contactRequirement",
        "constraintsMissing"
      ]
    }
  },
  required: ["thought", "requestedLeadCount", "emailRequired", "outputFormat", "objectiveBrief"]
} as const;

const AlfredLeadBriefOutputSchema: z.ZodType<AlfredLeadBriefOutput> = z.object({
  thought: z.string().min(1).max(500),
  requestedLeadCount: z.number().int().min(1).max(100),
  emailRequired: z.boolean(),
  outputFormat: z.string().min(2).max(80).nullable(),
  objectiveBrief: LeadExecutionBriefSchema.shape.objectiveBrief
});

function nowIso(): string {
  return new Date().toISOString();
}

function parseToolInputJson(inputJson: string | null): Record<string, unknown> | undefined {
  if (!inputJson) {
    return undefined;
  }
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

function formatSessionContextBlock(sessionContext?: SessionPromptContext): string {
  if (!sessionContext) {
    return "";
  }

  const lines: string[] = [
    "This is compact working memory from the current session. Use it when relevant to the current turn, especially if the user is clearly referring to prior work."
  ];

  if (sessionContext.activeObjective) {
    lines.push(`- Active objective: ${sessionContext.activeObjective}`);
  }
  if (sessionContext.lastRunId) {
    lines.push(`- Last run id: ${sessionContext.lastRunId}`);
  }
  if (sessionContext.lastCompletedRun?.runId) {
    lines.push(`- Last completed run id: ${sessionContext.lastCompletedRun.runId}`);
  }
  if (sessionContext.lastCompletedRun?.message) {
    lines.push(`- Last completed request: ${sessionContext.lastCompletedRun.message}`);
  }
  if (sessionContext.lastOutcomeSummary) {
    lines.push(`- Last outcome summary: ${sessionContext.lastOutcomeSummary}`);
  }
  const artifacts = sessionContext.lastArtifacts ?? sessionContext.lastCompletedRun?.artifactPaths;
  if (artifacts?.length) {
    lines.push(`- Last artifacts: ${artifacts.join(", ")}`);
  }
  if (sessionContext.sessionSummary) {
    lines.push(`- Session summary: ${sessionContext.sessionSummary}`);
  }

  return lines.join("\n");
}

function formatRecentTurnsBlock(sessionContext?: SessionPromptContext): string {
  const turns = sessionContext?.recentTurns?.slice(-6) ?? [];
  if (turns.length === 0) {
    return "";
  }

  return turns
    .map((turn) => `- ${turn.role} (${turn.timestamp}): ${turn.content}`)
    .join("\n");
}

function buildAlfredPlannerSystemPrompt(sessionContext?: SessionPromptContext): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Role",
      content:
        "You are Alfred, the master orchestrator. Decide whether to delegate to a specialist agent, call a tool directly, or respond. Focus on the current turn objective only."
    },
    {
      label: "Directives",
      content:
        "Treat this as the active task for this turn. Sessions can persist, but success criteria are based on the current turn unless user explicitly references prior work. Prefer delegating lead-generation execution to lead_agent. Use call_tool for lightweight diagnostics or direct retrieval when that is higher-value than full delegation. Use `turnState.completionCriteria`, `turnState.completedCriteria`, `turnState.missingRequirements`, and `turnState.blockingIssues` as the canonical execution state for replanning. After receiving specialist output, evaluate against the turn objective and either respond or re-delegate with a refined brief. Keep decisions prompt-driven; deterministic behavior should be limited to budget/safety guardrails."
    },
    {
      label: "Session Context",
      content: formatSessionContextBlock(sessionContext)
    },
    {
      label: "Recent Conversation",
      content: formatRecentTurnsBlock(sessionContext)
    }
  ]);
}

function buildAlfredCompletionEvaluatorSystemPrompt(sessionContext?: SessionPromptContext): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Role",
      content:
        "You are Alfred's completion evaluator. Decide whether the latest successful action already provides enough evidence to answer the current user turn."
    },
    {
      label: "Directives",
      content:
        "Respond `shouldRespond=true` only when the latest successful tool or delegated agent result is sufficient to answer the current turn with reasonable honesty. Use `turnState.completedCriteria`, `turnState.missingRequirements`, and `turnState.blockingIssues` as the canonical checklist. If the result is partial, missing key evidence, or needs another action, set `shouldRespond=false` and explain exactly what is still missing. Keep this prompt-driven; do not invent facts beyond the observed result."
    },
    {
      label: "Session Context",
      content: formatSessionContextBlock(sessionContext)
    },
    {
      label: "Recent Conversation",
      content: formatRecentTurnsBlock(sessionContext)
    }
  ]);
}

function buildAlfredLeadBriefSystemPrompt(sessionContext?: SessionPromptContext): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Role",
      content:
        "You are Alfred's lead brief builder. Convert the user's current conversational request into a canonical lead-execution brief."
    },
    {
      label: "Directives",
      content:
        "Use the current turn and relevant recent session context to infer the lead request. Preserve explicit user requirements exactly. Do not inflate counts, broaden geography, or weaken required contact/output requirements. The brief is an execution contract for downstream specialist work, not a place to reinterpret the request."
    },
    {
      label: "Session Context",
      content: formatSessionContextBlock(sessionContext)
    },
    {
      label: "Recent Conversation",
      content: formatRecentTurnsBlock(sessionContext)
    }
  ]);
}

function fallbackLeadExecutionBrief(message: string): LeadExecutionBrief {
  const normalizedMessage = message.replace(/\s+/g, " ").trim().slice(0, 400);
  const emailRequired = /\bemail(s)?\b/i.test(message);
  return {
    requestedLeadCount: parseRequestedLeadCount(message),
    emailRequired,
    outputFormat: /\bcsv\b/i.test(message) ? "csv" : null,
    objectiveBrief: {
      objectiveSummary: normalizedMessage || "Collect lead candidates matching the current user request.",
      companyType: null,
      industry: null,
      geography: null,
      businessModel: null,
      contactRequirement: emailRequired ? "email required" : "company data requested",
      constraintsMissing: []
    }
  };
}

async function buildLeadExecutionBrief(args: {
  apiKey?: string;
  structuredChatRunner: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
  message: string;
  sessionContext?: SessionPromptContext;
}): Promise<LeadExecutionBrief> {
  if (!args.apiKey) {
    return fallbackLeadExecutionBrief(args.message);
  }

  const diagnostic = await args.structuredChatRunner(
    {
      apiKey: args.apiKey,
      schemaName: "alfred_lead_execution_brief",
      jsonSchema: ALFRED_LEAD_BRIEF_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content: buildAlfredLeadBriefSystemPrompt(args.sessionContext)
        },
        {
          role: "user",
          content: JSON.stringify({
            turnObjective: args.message
          })
        }
      ]
    },
    AlfredLeadBriefOutputSchema
  );

  if (!diagnostic.result) {
    return fallbackLeadExecutionBrief(args.message);
  }

  return {
    requestedLeadCount: diagnostic.result.requestedLeadCount,
    emailRequired: diagnostic.result.emailRequired,
    outputFormat: diagnostic.result.outputFormat,
    objectiveBrief: diagnostic.result.objectiveBrief
  };
}

function truncateForPrompt(value: unknown, maxLength = 2400): string {
  const serialized =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, nestedValue) => {
          if (typeof nestedValue === "string" && nestedValue.length > 400) {
            return `${nestedValue.slice(0, 400)}...`;
          }
          return nestedValue;
        });
  return serialized.slice(0, maxLength);
}

function buildCompletionCriteria(message: string, leadExecutionBrief?: LeadExecutionBrief | null): string[] {
  if (leadExecutionBrief) {
    const criteria = [`Return exactly ${leadExecutionBrief.requestedLeadCount} leads.`];
    if (leadExecutionBrief.emailRequired) {
      criteria.push("Include email data for returned leads when required by the user.");
    }
    if (leadExecutionBrief.outputFormat) {
      criteria.push(`Produce or preserve the requested output format: ${leadExecutionBrief.outputFormat}.`);
    }
    if (leadExecutionBrief.objectiveBrief.geography) {
      criteria.push(`Keep the results within ${leadExecutionBrief.objectiveBrief.geography}.`);
    }
    return criteria;
  }

  return [`Answer the current turn directly and honestly: ${message.replace(/\s+/g, " ").trim().slice(0, 240)}`];
}

function findNumericField(source: unknown, keys: string[]): number | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function inferLeadFactsFromRunRecord(runRecord: RunRecord | undefined): { collectedLeadCount: number; collectedEmailCount: number } {
  let collectedLeadCount = 0;
  let collectedEmailCount = 0;

  for (const toolCall of [...(runRecord?.toolCalls ?? [])].reverse()) {
    if (toolCall.status !== "ok") {
      continue;
    }
    if (collectedLeadCount === 0) {
      collectedLeadCount =
        findNumericField(toolCall.outputRedacted, ["finalCandidateCount", "candidateCount", "totalCount"]) ??
        findNumericField(toolCall.inputRedacted, ["candidateCount"]) ??
        0;
    }
    if (collectedEmailCount === 0) {
      collectedEmailCount =
        findNumericField(toolCall.outputRedacted, ["emailLeadCount", "emailCount", "enrichedEmailCount"]) ?? 0;
    }
    if (collectedLeadCount > 0 && collectedEmailCount > 0) {
      break;
    }
  }

  return { collectedLeadCount, collectedEmailCount };
}

function buildAlfredTurnState(args: {
  message: string;
  leadExecutionBrief?: LeadExecutionBrief | null;
  leadState: LeadAgentState;
  lastAction: AlfredActionSnapshot | null;
  runRecord?: RunRecord;
}): AlfredTurnState {
  const canonicalLeadBrief = args.leadExecutionBrief ?? args.leadState.executionBrief ?? null;
  const inferredFacts = inferLeadFactsFromRunRecord(args.runRecord);
  const collectedLeadCount = Math.max(args.leadState.leads.length, inferredFacts.collectedLeadCount);
  const collectedEmailCount = Math.max(
    args.leadState.leads.filter((lead) => Boolean(lead.email)).length,
    inferredFacts.collectedEmailCount
  );
  const completedCriteria: string[] = [];
  const missingRequirements: string[] = [];
  const blockingIssues: string[] = [];

  if (canonicalLeadBrief) {
    if (collectedLeadCount >= canonicalLeadBrief.requestedLeadCount) {
      completedCriteria.push(`Lead count met (${collectedLeadCount}/${canonicalLeadBrief.requestedLeadCount}).`);
    } else {
      missingRequirements.push(
        `Need ${canonicalLeadBrief.requestedLeadCount - collectedLeadCount} more leads to satisfy the request.`
      );
    }

    if (canonicalLeadBrief.emailRequired) {
      if (collectedEmailCount >= canonicalLeadBrief.requestedLeadCount) {
        completedCriteria.push(`Email coverage met (${collectedEmailCount}/${canonicalLeadBrief.requestedLeadCount}).`);
      } else {
        missingRequirements.push(
          `Need email coverage for ${canonicalLeadBrief.requestedLeadCount - collectedEmailCount} more requested leads.`
        );
      }
    }

    if (canonicalLeadBrief.outputFormat) {
      if (args.leadState.artifacts.length > 0 || (args.runRecord?.artifactPaths?.length ?? 0) > 0) {
        completedCriteria.push(`Requested output format is available (${canonicalLeadBrief.outputFormat}).`);
      } else {
        missingRequirements.push(`Need a ${canonicalLeadBrief.outputFormat} artifact before the task is complete.`);
      }
    }
  } else if (args.lastAction?.status !== "completed") {
    missingRequirements.push("Need either a successful action result or a direct answer for the current turn.");
  }

  if (args.lastAction?.status === "failed") {
    blockingIssues.push(`Last action failed: ${args.lastAction.summary}`);
  } else if (args.lastAction?.status === "cancelled") {
    blockingIssues.push(`Last action was cancelled: ${args.lastAction.summary}`);
  }

  return {
    turnObjective: args.message,
    taskType: canonicalLeadBrief ? "lead_generation" : "general",
    canonicalLeadBrief,
    completionCriteria: buildCompletionCriteria(args.message, canonicalLeadBrief),
    completedCriteria,
    missingRequirements,
    blockingIssues,
    facts: {
      requestedLeadCount: canonicalLeadBrief?.requestedLeadCount ?? null,
      collectedLeadCount,
      collectedEmailCount,
      artifactCount: Math.max(args.leadState.artifacts.length, args.runRecord?.artifactPaths?.length ?? 0),
      fetchedPageCount: args.leadState.fetchedPages.length,
      shortlistedUrlCount: args.leadState.shortlistedUrls?.length ?? 0,
      outputFormat: canonicalLeadBrief?.outputFormat ?? null
    },
    lastAction: args.lastAction
  };
}

async function runCompletionEvaluator(args: {
  apiKey?: string;
  structuredChatRunner: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
  message: string;
  leadExecutionBrief?: LeadExecutionBrief;
  iteration: number;
  remainingMs: number;
  turnState: AlfredTurnState;
  recentObservations: Array<{ iteration: number; summary: string; outcome: string }>;
  lastDelegationSummary: string;
  actionSummary: string;
  latestResult: unknown;
  sessionContext?: SessionPromptContext;
}): Promise<openAiClient.StructuredChatDiagnostic<AlfredCompletionEvaluation>> {
  return args.structuredChatRunner(
    {
      apiKey: args.apiKey,
      schemaName: "alfred_completion_evaluation",
      jsonSchema: ALFRED_COMPLETION_EVALUATION_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content: buildAlfredCompletionEvaluatorSystemPrompt(args.sessionContext)
        },
        {
          role: "user",
          content: JSON.stringify({
            turnObjective: args.message,
            canonicalTaskBrief: args.leadExecutionBrief ?? null,
            turnState: args.turnState,
            iteration: args.iteration,
            remainingMs: args.remainingMs,
            actionSummary: args.actionSummary,
            lastDelegationSummary: args.lastDelegationSummary,
            recentObservations: args.recentObservations.slice(-5),
            latestResult: truncateForPrompt(args.latestResult, 2600)
          })
        }
      ]
    },
    AlfredCompletionEvaluationSchema
  );
}

export async function runAlfredOrchestratorLoop(options: AlfredOrchestratorOptions): Promise<RunOutcome> {
  const startMs = Date.now();
  const deadlineAtMs = startMs + options.maxDurationMs;
  const leadAgentAllowlist = resolveLeadAgentToolAllowlist();
  const discoveredTools = await discoverLeadAgentTools();
  const availableTools = applyToolAllowlist(discoveredTools, leadAgentAllowlist);
  const availableToolSpecs = Array.from(availableTools.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputHint: tool.inputHint
  }));
  const availableAgents = listAgentSkills().map((skill) => ({
    name: skill.name,
    description: skill.description
  }));

  const alfredState: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: 0,
    fetchedPages: [],
    shortlistedUrls: []
  };
  const addLeads: LeadAgentToolContext["addLeads"] = (incoming) => {
    let addedCount = 0;
    for (const lead of incoming) {
      const existingIndex = alfredState.leads.findIndex((item) => item.sourceUrl === lead.sourceUrl && item.companyName === lead.companyName);
      if (existingIndex >= 0) {
        if (lead.confidence > (alfredState.leads[existingIndex]?.confidence ?? 0)) {
          alfredState.leads[existingIndex] = lead;
        }
      } else {
        alfredState.leads.push(lead);
        addedCount += 1;
      }
    }
    return { addedCount, totalCount: alfredState.leads.length };
  };
  const addArtifact: LeadAgentToolContext["addArtifact"] = (artifactPath) => {
    if (!alfredState.artifacts.includes(artifactPath)) {
      alfredState.artifacts.push(artifactPath);
    }
  };
  const setFetchedPages: LeadAgentToolContext["setFetchedPages"] = (pages) => {
    alfredState.fetchedPages = pages;
  };
  const getFetchedPages: LeadAgentToolContext["getFetchedPages"] = () => alfredState.fetchedPages;
  const setShortlistedUrls: LeadAgentToolContext["setShortlistedUrls"] = (urls) => {
    alfredState.shortlistedUrls = Array.from(new Set(urls.map((item) => item.trim()).filter(Boolean)));
  };
  const getShortlistedUrls: LeadAgentToolContext["getShortlistedUrls"] = () => alfredState.shortlistedUrls ?? [];

  const toolContext: LeadAgentToolContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    message: options.message,
    deadlineAtMs,
    policyMode: options.policyMode,
    projectRoot: process.cwd(),
    runStore: options.runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    openAiApiKey: options.openAiApiKey,
    defaults: options.defaults,
    leadPipelineExecutor: options.leadPipelineExecutor,
    state: alfredState,
    isCancellationRequested: options.isCancellationRequested,
    addLeads,
    addArtifact,
    setFetchedPages,
    getFetchedPages,
    setShortlistedUrls,
    getShortlistedUrls
  };

  const observations: Array<{ iteration: number; summary: string; outcome: string }> = [];
  let plannerCallsUsed = 0;
  let toolCallsUsed = 0;
  let lastDelegationSummary = "No delegation attempted yet.";
  let lastCompletionNote = "No completion evaluation yet.";
  let lastAction: AlfredActionSnapshot | null = null;
  let latestRunRecord: RunRecord | undefined;
  const scratchpad: Record<string, unknown> = {
    currentTurnObjective: options.message
  };
  const refreshTurnState = (): AlfredTurnState => {
    const turnState = buildAlfredTurnState({
      message: options.message,
      leadExecutionBrief: (scratchpad.currentLeadExecutionBrief as LeadExecutionBrief | undefined) ?? undefined,
      leadState: alfredState,
      lastAction,
      runRecord: latestRunRecord
    });
    scratchpad.currentTurnState = turnState;
    return turnState;
  };
  refreshTurnState();
  const structuredChatRunner = options.structuredChatRunner ?? openAiClient.runOpenAiStructuredChatWithDiagnostics;
  const agentLoopRunner = options.agentLoopRunner ?? runAgentLoop;
  const buildLeadAgentRuntimeOptions = (message: string, leadExecutionBrief?: LeadExecutionBrief): LeadAgentRuntimeOptions => ({
    scratchpad,
    leadExecutionBrief,
    runStore: options.runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    message,
    runId: options.runId,
    sessionId: options.sessionId,
    openAiApiKey: options.openAiApiKey,
    defaults: options.defaults,
    leadPipelineExecutor: options.leadPipelineExecutor,
    maxIterations: options.maxIterations,
    maxDurationMs: Math.max(60_000, options.maxDurationMs - (Date.now() - startMs)),
    maxToolCalls: options.maxToolCalls,
    maxParallelTools: options.maxParallelTools,
    plannerMaxCalls: options.plannerMaxCalls,
    observationWindow: options.observationWindow,
    diminishingThreshold: options.diminishingThreshold,
    policyMode: options.policyMode,
    isCancellationRequested: options.isCancellationRequested
  });

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "alfred_loop_started",
    payload: {
      maxIterations: options.maxIterations,
      maxDurationMs: options.maxDurationMs,
      availableAgents,
      availableTools: availableToolSpecs,
      promptStack: {
        master: ALFRED_MASTER_PROMPT_VERSION
      },
      sessionContextLoaded: Boolean(options.sessionContext)
    },
    timestamp: nowIso()
  });
  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "alfred_turn_state_updated",
    payload: {
      iteration: 0,
      turnState: scratchpad.currentTurnState
    },
    timestamp: nowIso()
  });

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    if (await options.isCancellationRequested()) {
      return {
        status: "cancelled",
        assistantText: "Run cancelled by user request."
      };
    }
    if (Date.now() >= deadlineAtMs) {
      break;
    }

    if (!options.openAiApiKey) {
      const leadOutcome = await agentLoopRunner({
        skillName: "lead_agent",
        ...buildLeadAgentRuntimeOptions(
          options.message,
          await buildLeadExecutionBrief({
            apiKey: options.openAiApiKey,
            structuredChatRunner,
            message: options.message,
            sessionContext: options.sessionContext
          })
        )
      });
      return leadOutcome;
    }

    const plannerDiagnostic = await structuredChatRunner(
      {
        apiKey: options.openAiApiKey,
        schemaName: "alfred_orchestrator_plan",
        jsonSchema: ALFRED_PLANNER_OUTPUT_JSON_SCHEMA,
        messages: [
          {
            role: "system",
            content: buildAlfredPlannerSystemPrompt(options.sessionContext)
          },
          {
            role: "user",
            content: JSON.stringify({
              turnObjective: options.message,
              currentLeadExecutionBrief: (scratchpad.currentLeadExecutionBrief as LeadExecutionBrief | undefined) ?? null,
              turnState: refreshTurnState(),
              iteration,
              remainingMs: Math.max(0, deadlineAtMs - Date.now()),
              availableAgents,
              availableTools: availableToolSpecs,
              recentObservations: observations.slice(-5),
              lastDelegationSummary,
              lastCompletionNote
            })
          }
        ]
      },
      AlfredPlannerOutputSchema
    );

    plannerCallsUsed += 1;
    if (plannerDiagnostic.usage) {
      await options.runStore.addLlmUsage(options.runId, plannerDiagnostic.usage, 1);
    }

    if (!plannerDiagnostic.result) {
      observations.push({
        iteration,
        summary: "planner_failed",
        outcome: plannerDiagnostic.failureMessage?.slice(0, 220) ?? "planner_failed"
      });
      if (observations.length >= 2) {
        break;
      }
      continue;
    }

    const plan = plannerDiagnostic.result;
    lastAction = {
      iteration,
      actionType: plan.actionType,
      name: plan.delegateAgent ?? plan.toolName ?? "respond",
      status: "planned",
      summary: plan.thought
    };
    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "alfred_plan_created",
      payload: {
        iteration,
        thought: plan.thought,
        actionType: plan.actionType,
        delegateAgent: plan.delegateAgent,
        toolName: plan.toolName,
        turnState: refreshTurnState()
      },
      timestamp: nowIso()
    });

    if (plan.actionType === "respond") {
      lastAction = {
        iteration,
        actionType: "respond",
        name: "respond",
        status: "completed",
        summary: (plan.responseText ?? lastDelegationSummary).slice(0, 280)
      };
      return {
        status: "completed",
        assistantText: plan.responseText ?? lastDelegationSummary,
        artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
      };
    }

    if (plan.actionType === "delegate_agent") {
      const agentName = plan.delegateAgent?.trim().toLowerCase();
      if (!agentName || !availableAgents.some((agent) => agent.name === agentName)) {
        lastAction = {
          iteration,
          actionType: "delegate_agent",
          name: plan.delegateAgent ?? "unknown",
          status: "failed",
          summary: "unsupported_delegate_agent"
        };
        observations.push({
          iteration,
          summary: `unsupported_delegate:${plan.delegateAgent ?? "null"}`,
          outcome: "unsupported_delegate_agent"
        });
        continue;
      }

      const delegatedMessage = (plan.delegateBrief ?? options.message).slice(0, 1200);
      const leadExecutionBrief = agentName === "lead_agent"
        ? await buildLeadExecutionBrief({
            apiKey: options.openAiApiKey,
            structuredChatRunner,
            message: options.message,
            sessionContext: options.sessionContext
          })
        : undefined;
      const delegationId = `delegation_${iteration}`;
      scratchpad[`delegation.${delegationId}.brief`] = delegatedMessage;
      if (leadExecutionBrief) {
        scratchpad.currentLeadExecutionBrief = leadExecutionBrief;
        alfredState.executionBrief = leadExecutionBrief;
        toolContext.leadExecutionBrief = leadExecutionBrief;
        scratchpad[`delegation.${delegationId}.leadExecutionBrief`] = leadExecutionBrief;
      }
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "agent_delegated",
        payload: {
          iteration,
          delegationId,
          agentName,
          brief: delegatedMessage,
          leadExecutionBrief,
          scratchpadKeys: Object.keys(scratchpad).sort()
        },
        timestamp: nowIso()
      });
      const leadOutcome = await agentLoopRunner({
        skillName: agentName,
        parentRunId: options.runId,
        delegationId,
        ...buildLeadAgentRuntimeOptions(delegatedMessage, leadExecutionBrief)
      });
      scratchpad[`delegation.${delegationId}.result`] = {
        status: leadOutcome.status,
        assistantText: (leadOutcome.assistantText ?? "").slice(0, 400),
        artifactPaths: leadOutcome.artifactPaths ?? []
      };
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "agent_delegation_result",
        payload: {
          iteration,
          delegationId,
          agentName,
          status: leadOutcome.status,
          artifactCount: leadOutcome.artifactPaths?.length ?? 0,
          scratchpadKeys: Object.keys(scratchpad).sort()
        },
        timestamp: nowIso()
      });

      const runRecord = await options.runStore.getRun(options.runId);
      latestRunRecord = runRecord ?? latestRunRecord;
      const recentToolCalls = runRecord?.toolCalls.slice(-6) ?? [];
      toolCallsUsed = runRecord?.toolCalls.length ?? toolCallsUsed;
      if (leadOutcome.artifactPaths?.length) {
        for (const artifact of leadOutcome.artifactPaths) {
          addArtifact(artifact);
        }
      }
      if (runRecord?.artifactPaths?.length) {
        for (const artifact of runRecord.artifactPaths) {
          addArtifact(artifact);
        }
      }

      lastDelegationSummary = [
        `status=${leadOutcome.status}`,
        `assistantText=${(leadOutcome.assistantText ?? "").slice(0, 400)}`,
        `recentTools=${recentToolCalls.map((call) => `${call.toolName}:${call.status}`).join(", ")}`
      ].join(" | ");
      lastAction = {
        iteration,
        actionType: "delegate_agent",
        name: agentName,
        status: leadOutcome.status === "cancelled" ? "cancelled" : "completed",
        summary: lastDelegationSummary.slice(0, 280)
      };
      const delegatedTurnState = refreshTurnState();
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "alfred_turn_state_updated",
        payload: {
          iteration,
          turnState: delegatedTurnState
        },
        timestamp: nowIso()
      });

      observations.push({
        iteration,
        summary: `delegate_lead_agent`,
        outcome: lastDelegationSummary.slice(0, 500)
      });

      if (leadOutcome.status === "cancelled") {
        return leadOutcome;
      }

      if (plannerCallsUsed < options.plannerMaxCalls) {
        const completionDiagnostic = await runCompletionEvaluator({
          apiKey: options.openAiApiKey,
          structuredChatRunner,
          message: options.message,
          leadExecutionBrief,
          iteration,
          remainingMs: Math.max(0, deadlineAtMs - Date.now()),
          turnState: delegatedTurnState,
          recentObservations: observations,
          lastDelegationSummary,
          actionSummary: `delegate_agent:${agentName}`,
          latestResult: {
            status: leadOutcome.status,
            assistantText: leadOutcome.assistantText,
            artifactPaths: leadOutcome.artifactPaths
          },
          sessionContext: options.sessionContext
        });
        plannerCallsUsed += 1;
        if (completionDiagnostic.usage) {
          await options.runStore.addLlmUsage(options.runId, completionDiagnostic.usage, 1);
        }
        const completionResult = completionDiagnostic.result;
        if (completionResult) {
          lastCompletionNote = completionResult.shouldRespond
            ? `Completion evaluator: respond now (${completionResult.confidence.toFixed(2)} confidence).`
            : `Completion evaluator: continue gathering. ${completionResult.continueReason ?? completionResult.thought}`;
          await options.runStore.appendEvent({
            runId: options.runId,
            sessionId: options.sessionId,
            phase: "thought",
            eventType: "alfred_completion_evaluated",
            payload: {
              iteration,
              actionSummary: `delegate_agent:${agentName}`,
              shouldRespond: completionResult.shouldRespond,
              confidence: completionResult.confidence,
              thought: completionResult.thought,
              continueReason: completionResult.continueReason
            },
            timestamp: nowIso()
          });
          if (completionResult.shouldRespond) {
            return {
              status: "completed",
              assistantText: completionResult.responseText ?? leadOutcome.assistantText ?? lastDelegationSummary,
              artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
            };
          }
          observations.push({
            iteration,
            summary: "completion_eval:continue",
            outcome: (completionResult.continueReason ?? completionResult.thought).slice(0, 260)
          });
        } else if (completionDiagnostic.failureMessage) {
          lastCompletionNote = `Completion evaluator failed: ${completionDiagnostic.failureMessage.slice(0, 180)}`;
        }
      }

      continue;
    }

    if (plan.actionType === "call_tool") {
      const toolName = plan.toolName?.trim() ?? "";
      const tool = availableTools.get(toolName);
      if (!tool) {
        lastAction = {
          iteration,
          actionType: "call_tool",
          name: toolName || "unknown",
          status: "failed",
          summary: "tool_not_found"
        };
        observations.push({
          iteration,
          summary: `tool_not_found:${toolName || "null"}`,
          outcome: "tool_not_found"
        });
        continue;
      }
      const input = parseToolInputJson(plan.toolInputJson);
      if (!input) {
        lastAction = {
          iteration,
          actionType: "call_tool",
          name: toolName,
          status: "failed",
          summary: "invalid_tool_input"
        };
        observations.push({
          iteration,
          summary: `invalid_tool_input:${toolName}`,
          outcome: "invalid_tool_input"
        });
        continue;
      }
      const parsedInput = tool.inputSchema.safeParse(input);
      if (!parsedInput.success) {
        lastAction = {
          iteration,
          actionType: "call_tool",
          name: toolName,
          status: "failed",
          summary: parsedInput.error.message.slice(0, 180)
        };
        observations.push({
          iteration,
          summary: `tool_schema_error:${toolName}`,
          outcome: parsedInput.error.message.slice(0, 200)
        });
        continue;
      }

      const started = Date.now();
      let toolExecutedSuccessfully = false;
      let latestToolOutput: unknown;
      try {
        const output = await tool.execute(parsedInput.data, toolContext);
        toolCallsUsed += 1;
        toolExecutedSuccessfully = true;
        latestToolOutput = output;
        await options.runStore.addToolCall(options.runId, {
          toolName,
          inputRedacted: redactValue(parsedInput.data),
          outputRedacted: redactValue(output),
          durationMs: Date.now() - started,
          status: "ok",
          timestamp: nowIso()
        });
        observations.push({
          iteration,
          summary: `tool:${toolName}:ok`,
          outcome: JSON.stringify(output).slice(0, 260)
        });
        lastAction = {
          iteration,
          actionType: "call_tool",
          name: toolName,
          status: "completed",
          summary: JSON.stringify(output).slice(0, 280)
        };
      } catch (error) {
        toolCallsUsed += 1;
        const errorMessage = error instanceof Error ? error.message.slice(0, 220) : "tool_execution_failed";
        await options.runStore.addToolCall(options.runId, {
          toolName,
          inputRedacted: redactValue(parsedInput.data),
          outputRedacted: { error: errorMessage },
          durationMs: Date.now() - started,
          status: "error",
          timestamp: nowIso()
        });
        observations.push({
          iteration,
          summary: `tool:${toolName}:error`,
          outcome: errorMessage
        });
        lastAction = {
          iteration,
          actionType: "call_tool",
          name: toolName,
          status: "failed",
          summary: errorMessage
        };
      }
      latestRunRecord = (await options.runStore.getRun(options.runId)) ?? latestRunRecord;
      const postToolTurnState = refreshTurnState();
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "alfred_turn_state_updated",
        payload: {
          iteration,
          turnState: postToolTurnState
        },
        timestamp: nowIso()
      });

      if (toolExecutedSuccessfully && plannerCallsUsed < options.plannerMaxCalls) {
        const completionDiagnostic = await runCompletionEvaluator({
          apiKey: options.openAiApiKey,
          structuredChatRunner,
          message: options.message,
          leadExecutionBrief: undefined,
          iteration,
          remainingMs: Math.max(0, deadlineAtMs - Date.now()),
          turnState: postToolTurnState,
          recentObservations: observations,
          lastDelegationSummary,
          actionSummary: `call_tool:${toolName}`,
          latestResult: latestToolOutput,
          sessionContext: options.sessionContext
        });
        plannerCallsUsed += 1;
        if (completionDiagnostic.usage) {
          await options.runStore.addLlmUsage(options.runId, completionDiagnostic.usage, 1);
        }
        const completionResult = completionDiagnostic.result;
        if (completionResult) {
          lastCompletionNote = completionResult.shouldRespond
            ? `Completion evaluator: respond now (${completionResult.confidence.toFixed(2)} confidence).`
            : `Completion evaluator: continue gathering. ${completionResult.continueReason ?? completionResult.thought}`;
          await options.runStore.appendEvent({
            runId: options.runId,
            sessionId: options.sessionId,
            phase: "thought",
            eventType: "alfred_completion_evaluated",
            payload: {
              iteration,
              actionSummary: `call_tool:${toolName}`,
              shouldRespond: completionResult.shouldRespond,
              confidence: completionResult.confidence,
              thought: completionResult.thought,
              continueReason: completionResult.continueReason
            },
            timestamp: nowIso()
          });
          if (completionResult.shouldRespond) {
            return {
              status: "completed",
              assistantText: completionResult.responseText ?? JSON.stringify(latestToolOutput).slice(0, 1000),
              artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
            };
          }
          observations.push({
            iteration,
            summary: "completion_eval:continue",
            outcome: (completionResult.continueReason ?? completionResult.thought).slice(0, 260)
          });
        } else if (completionDiagnostic.failureMessage) {
          lastCompletionNote = `Completion evaluator failed: ${completionDiagnostic.failureMessage.slice(0, 180)}`;
        }
      }
    }

    if (plannerCallsUsed >= options.plannerMaxCalls || toolCallsUsed >= options.maxToolCalls) {
      break;
    }
  }

  const fallbackText =
    lastDelegationSummary !== "No delegation attempted yet."
      ? `Alfred orchestration stopped by budget guardrails. Latest specialist result: ${lastDelegationSummary}`
      : "Alfred orchestration stopped by budget guardrails before producing a conclusive result.";
  return {
    status: "completed",
    assistantText: fallbackText,
    artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
  };
}
