import { z } from "zod";
import type { PolicyMode, RunEvent, RunOutcome, RunRecord, SessionOutputRecord, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import * as openAiClient from "../services/openAiClient.js";
import { composeSystemPrompt } from "../prompts/composePrompt.js";
import { ALFRED_MASTER_PROMPT_VERSION, ALFRED_MASTER_SYSTEM_PROMPT } from "../prompts/master/alfred.system.js";
import type { LeadAgentRuntimeOptions } from "./runLeadAgenticLoop.js";
import { runAgentLoop } from "./runAgentLoop.js";
import { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import type { LeadAgentDefaults, LeadAgentState, LeadAgentToolContext } from "../agent/types.js";
import { discoverLeadAgentTools } from "../agent/tools/registry.js";
import { redactValue } from "../utils/redact.js";
import { listAgentSkills } from "../agent/skills/registry.js";
import type { AgentTaskContract } from "../agent/skills/types.js";
import { buildRuntimeSessionContext, loadSessionOutputBodyPreview } from "../memory/sessionOutputResolver.js";
import { LeadExecutionBriefSchema, type LeadExecutionBrief } from "../tools/lead/schemas.js";
import { classifyStructuredFailure, computeRetryDelayMs, sleep } from "./reliability.js";
import { getToolInputContract } from "../agent/toolContracts.js";

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
  responseKind: "final" | "clarification" | "progress" | null;
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

interface AlfredTurnGroundingOutput {
  thought: string;
  source: "message" | "recent_output" | "recent_turn" | "active_objective" | "last_completed_run";
  groundedObjective: string;
  referencedOutputId: string | null;
}

interface AlfredTurnInterpretationOutput {
  thought: string;
  groundedObjective: string;
  taskType: AlfredTaskType;
  requiredDeliverable: string;
  hardConstraints: string[];
  doneCriteria: string[];
  assumptions: string[];
  requiresDraft: boolean;
  requiresCitations: boolean;
  targetWordCount: number | null;
  requestedOutputPath: string | null;
  clarificationNeeded: boolean;
  clarificationQuestion: string | null;
}

type AlfredTaskType = "lead_generation" | "general";

interface AlfredActionSnapshot {
  iteration: number;
  actionType: "delegate_agent" | "call_tool" | "respond" | "system";
  name: string;
  status: "planned" | "completed" | "failed" | "cancelled";
  summary: string;
}

interface AlfredObjectiveContract {
  taskType: AlfredTaskType;
  requiredDeliverable: string;
  hardConstraints: string[];
  softPreferences: string[];
  doneCriteria: string[];
  assumptions: string[];
  requiresDraft: boolean;
  requiresCitations: boolean;
  targetWordCountHint: number | null;
  requestedOutputPathHint: string | null;
}

interface AlfredTurnState {
  turnObjective: string;
  taskType: AlfredTaskType;
  objectiveContract: AlfredObjectiveContract;
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
    requestedOutputPath: string | null;
    draftWordCount: number;
    citationCount: number;
    resolvedOutputPath: string | null;
  };
  lastAction: AlfredActionSnapshot | null;
}

interface CompletionGateDecision {
  allowed: boolean;
  reason?: string;
}

type AlfredTurnMode = "diagnostic" | "execute";
type AlfredExecutionPermission = "execute" | "plan_only";

const FOLLOW_UP_CONTINUATION_EXACT_PHRASES = new Set([
  "try again",
  "retry",
  "rerun",
  "run again",
  "proceed",
  "continue",
  "go ahead",
  "do it",
  "yes",
  "yep",
  "yeah",
  "ok",
  "okay",
  "you decide",
  "your call",
  "up to you",
  "surprise me",
  "pick for me",
  "lets go",
  "let's go",
  "do that",
  "that works",
  "sounds good"
]);

function isWhitespaceChar(value: string): boolean {
  return value === " " || value === "\n" || value === "\t" || value === "\r" || value === "\f" || value === "\v";
}

function collapseWhitespace(value: string): string {
  let output = "";
  let inWhitespace = false;
  for (const ch of value) {
    if (isWhitespaceChar(ch)) {
      if (!inWhitespace && output.length > 0) {
        output += " ";
      }
      inWhitespace = true;
      continue;
    }
    output += ch;
    inWhitespace = false;
  }
  return output.trim();
}

function trimPunctuationEdges(value: string): string {
  const punctuation = ".,!?;:'\"`[](){}<>|";
  let start = 0;
  let end = value.length;
  while (start < end && punctuation.includes(value[start] ?? "")) {
    start += 1;
  }
  while (end > start && punctuation.includes(value[end - 1] ?? "")) {
    end -= 1;
  }
  return value.slice(start, end);
}

function tokenizeLower(value: string): string[] {
  const normalized = collapseWhitespace(value).toLowerCase();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(" ")
    .map((token) => trimPunctuationEdges(token))
    .filter((token) => token.length > 0);
}

function containsAnyWord(value: string, words: string[]): boolean {
  const tokens = new Set(tokenizeLower(value));
  for (const word of words) {
    if (tokens.has(word.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function containsAnyPhrase(value: string, phrases: string[]): boolean {
  const normalized = collapseWhitespace(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  for (const phrase of phrases) {
    if (normalized.includes(phrase.toLowerCase())) {
      return true;
    }
  }
  return false;
}

interface ParsedSlashCommand {
  name: string;
  args: string[];
}

function parseSlashCommand(message: string): ParsedSlashCommand | null {
  const normalized = collapseWhitespace(message);
  if (!normalized.startsWith("/")) {
    return null;
  }
  const withoutPrefix = normalized.slice(1).trim();
  if (!withoutPrefix) {
    return null;
  }
  const parts = withoutPrefix
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return {
    name: (parts[0] ?? "").toLowerCase(),
    args: parts.slice(1)
  };
}

function isHexChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isLikelyUuid(value: string): boolean {
  if (value.length !== 36) {
    return false;
  }
  const dashPositions = new Set([8, 13, 18, 23]);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (dashPositions.has(index)) {
      if (char !== "-") {
        return false;
      }
      continue;
    }
    if (!isHexChar(char)) {
      return false;
    }
  }
  return true;
}

function isFollowUpContinuationMessage(message: string): boolean {
  const trimmed = collapseWhitespace(message);
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (FOLLOW_UP_CONTINUATION_EXACT_PHRASES.has(normalized)) {
    return true;
  }
  if (trimmed.length > 24) {
    return false;
  }
  return containsAnyWord(trimmed, ["again", "retry", "proceed", "continue", "decide"])
    || containsAnyPhrase(trimmed, ["your call", "up to you"]);
}

function isSubstantiveObjective(text: string | undefined): text is string {
  if (typeof text !== "string") {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.length < 20) {
    return false;
  }
  return !isFollowUpContinuationMessage(trimmed);
}

function resolveTurnObjective(
  message: string,
  sessionContext?: SessionPromptContext
): { objective: string; source: "message" | "recent_turn" | "active_objective" | "last_completed_run" } {
  if (!isFollowUpContinuationMessage(message)) {
    return {
      objective: message,
      source: "message"
    };
  }

  const normalizedMessage = collapseWhitespace(message).toLowerCase();
  const recentUserTurn = [...(sessionContext?.recentTurns ?? [])]
    .reverse()
    .find((turn) => {
      if (turn.role !== "user") {
        return false;
      }
      const content = collapseWhitespace(turn.content);
      if (!isSubstantiveObjective(content)) {
        return false;
      }
      return content.toLowerCase() !== normalizedMessage;
    });
  if (recentUserTurn) {
    return {
      objective: `${recentUserTurn.content}\n\nFollow-up instruction: ${message.trim()}`,
      source: "recent_turn"
    };
  }

  if (isSubstantiveObjective(sessionContext?.activeObjective)) {
    return {
      objective: `${sessionContext.activeObjective}\n\nFollow-up instruction: ${message.trim()}`,
      source: "active_objective"
    };
  }

  if (isSubstantiveObjective(sessionContext?.lastCompletedRun?.message)) {
    return {
      objective: `${sessionContext.lastCompletedRun.message}\n\nFollow-up instruction: ${message.trim()}`,
      source: "last_completed_run"
    };
  }

  return {
    objective: message,
    source: "message"
  };
}

function buildAlfredTurnGroundingSystemPrompt(sessionContext?: SessionPromptContext): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Role",
      content:
        "Ground the current user turn against recent session outputs and recent conversation when the user is clearly referring to prior work."
    },
    {
      label: "Directives",
      content:
        "Use the current user turn as the primary source of truth. If it clearly refers to a prior session output or earlier task, rewrite the objective into one grounded objective that combines the prior work with the current request. Prefer `recent_output` when the user is acting on an existing artifact or draft. Do not invent unavailable body text; if only metadata exists, keep the grounded objective truthful about that limitation. If the current turn already stands alone, return `source=message` and preserve it closely."
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

async function resolveTurnObjectiveWithSessionGrounding(args: {
  apiKey?: string;
  structuredChatRunner: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
  message: string;
  sessionContext?: SessionPromptContext;
}): Promise<openAiClient.StructuredChatDiagnostic<AlfredTurnGroundingOutput> & {
  fallback: { objective: string; source: "message" | "recent_turn" | "active_objective" | "last_completed_run" };
}> {
  const fallback = resolveTurnObjective(args.message, args.sessionContext);
  if (!args.apiKey || (args.sessionContext?.recentOutputs?.length ?? 0) === 0) {
    return {
      result: {
        thought: "No session-output grounding required.",
        source: fallback.source,
        groundedObjective: fallback.objective,
        referencedOutputId: null
      },
      fallback
    };
  }

  const recentOutputs = (args.sessionContext?.recentOutputs ?? []).slice(-4).map((output) => ({
    id: output.id,
    kind: output.kind,
    title: output.title,
    summary: output.summary,
    availability: output.availability,
    artifactPath: output.artifactPath ?? null,
    metadata: output.metadata ?? null
  }));

  const diagnostic = await args.structuredChatRunner(
    {
      apiKey: args.apiKey,
      schemaName: "alfred_turn_grounding",
      jsonSchema: ALFRED_TURN_GROUNDING_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content: buildAlfredTurnGroundingSystemPrompt(args.sessionContext)
        },
        {
          role: "user",
          content: JSON.stringify({
            currentMessage: args.message,
            recentOutputs,
            recentTurns: args.sessionContext?.recentTurns?.slice(-6) ?? [],
            activeObjective: args.sessionContext?.activeObjective ?? null,
            lastCompletedRun: args.sessionContext?.lastCompletedRun ?? null
          })
        }
      ]
    },
    AlfredTurnGroundingOutputSchema
  );

  return {
    ...diagnostic,
    fallback
  };
}

function buildAlfredTurnInterpretationSystemPrompt(sessionContext?: SessionPromptContext): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Role",
      content:
        "Interpret the current execute-mode user turn into a stable execution contract for Alfred. Own semantics; do not leave intent to deterministic prompt classifiers."
    },
    {
      label: "Directives",
      content:
        "Use the current user turn as primary truth, while considering session context and recent conversation. Produce a grounded objective, deliverable, hard constraints, and done criteria that preserve explicit user requirements. Only set `clarificationNeeded=true` when missing information is genuinely blocking and assumptions would materially risk the outcome. If reasonable defaults or assumptions can unblock the work, set `clarificationNeeded=false`, proceed, and record those assumptions explicitly."
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

async function interpretTurnWithModel(args: {
  apiKey?: string;
  structuredChatRunner: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
  originalMessage: string;
  groundedObjective: string;
  sessionContext?: SessionPromptContext;
}): Promise<openAiClient.StructuredChatDiagnostic<AlfredTurnInterpretationOutput>> {
  if (!args.apiKey) {
    return {};
  }
  return args.structuredChatRunner(
    {
      apiKey: args.apiKey,
      schemaName: "alfred_turn_interpretation",
      jsonSchema: ALFRED_TURN_INTERPRETATION_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content: buildAlfredTurnInterpretationSystemPrompt(args.sessionContext)
        },
        {
          role: "user",
          content: JSON.stringify({
            currentMessage: args.originalMessage,
            groundedObjective: args.groundedObjective,
            sessionContext: {
              activeObjective: args.sessionContext?.activeObjective ?? null,
              lastCompletedRun: args.sessionContext?.lastCompletedRun ?? null,
              recentOutputs: args.sessionContext?.recentOutputs ?? [],
              unresolvedItems: args.sessionContext?.unresolvedItems ?? []
            },
            recentConversation: args.sessionContext?.recentTurns?.slice(-6) ?? []
          })
        }
      ]
    },
    AlfredTurnInterpretationOutputSchema
  );
}

function looksLikeExecutableLeadRequest(message: string): boolean {
  const hasLeadIntent = containsAnyWord(message, ["find", "get", "list", "collect", "source", "prospect"]);
  const hasLeadEntity = containsAnyWord(message, ["lead", "leads", "msp", "contact", "contacts"])
    || containsAnyPhrase(message, ["systems integrator"]);
  const hasCount = tokenizeLower(message).some((token) => Number.isFinite(Number.parseInt(token, 10)));
  return hasLeadIntent && hasLeadEntity && hasCount;
}

function detectTurnMode(message: string): AlfredTurnMode {
  const command = parseSlashCommand(message);
  if (!command) {
    return "execute";
  }
  if (command.name === "diagnose" || command.name === "debug" || command.name === "run-diagnostics") {
    return "diagnostic";
  }
  return "execute";
}

function detectExecutionPermission(message: string): AlfredExecutionPermission {
  const command = parseSlashCommand(message);
  if (!command) {
    return "execute";
  }
  if (command.name === "plan" || command.name === "dry-run") {
    return "plan_only";
  }
  return "execute";
}

function buildPlanOnlyResponse(plan: AlfredPlannerOutput, message: string): string {
  const cleanedObjective = collapseWhitespace(message);
  const lines = [
    "Execution permission is plan-only. I will not execute tools or delegate agents in this turn.",
    `Objective interpreted: ${cleanedObjective.slice(0, 220)}`
  ];
  if (plan.actionType === "delegate_agent" && plan.delegateAgent) {
    lines.push(`Recommended specialist: ${plan.delegateAgent}.`);
    if (plan.delegateBrief) {
      lines.push(`Recommended brief: ${plan.delegateBrief.slice(0, 360)}`);
    }
  } else if (plan.actionType === "call_tool" && plan.toolName) {
    lines.push(`Recommended first tool: ${plan.toolName}.`);
    if (plan.toolInputJson) {
      lines.push(`Suggested input: ${plan.toolInputJson.slice(0, 360)}`);
    }
  } else if (plan.responseText) {
    lines.push(plan.responseText.slice(0, 500));
  }
  lines.push("Reply with 'proceed' (or remove the no-execution instruction) when you want me to run this plan.");
  return lines.join("\n");
}

function extractRunIdFromMessage(message: string): string | null {
  const command = parseSlashCommand(message);
  if (!command) {
    return null;
  }
  for (const arg of command.args) {
    const trimmed = trimPunctuationEdges(arg);
    if (isLikelyUuid(trimmed)) {
      return trimmed;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex > 0) {
      const valuePart = trimPunctuationEdges(trimmed.slice(separatorIndex + 1));
      if (isLikelyUuid(valuePart)) {
        return valuePart;
      }
    }
  }
  return null;
}

const ALFRED_PLANNER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    actionType: { type: "string", enum: ["delegate_agent", "call_tool", "respond"] },
    responseKind: { anyOf: [{ type: "string", enum: ["final", "clarification", "progress"] }, { type: "null" }] },
    delegateAgent: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    delegateBrief: { anyOf: [{ type: "string", minLength: 1, maxLength: 1200 }, { type: "null" }] },
    toolName: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    toolInputJson: { anyOf: [{ type: "string", minLength: 2, maxLength: 1200 }, { type: "null" }] },
    responseText: { anyOf: [{ type: "string", minLength: 1, maxLength: 4000 }, { type: "null" }] }
  },
  required: ["thought", "actionType", "responseKind", "delegateAgent", "delegateBrief", "toolName", "toolInputJson", "responseText"]
} as const;

const AlfredPlannerOutputSchema: z.ZodType<AlfredPlannerOutput> = z.object({
  thought: z.string().min(1).max(500),
  actionType: z.enum(["delegate_agent", "call_tool", "respond"]),
  responseKind: z.enum(["final", "clarification", "progress"]).nullable(),
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

const ALFRED_TURN_GROUNDING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    source: {
      type: "string",
      enum: ["message", "recent_output", "recent_turn", "active_objective", "last_completed_run"]
    },
    groundedObjective: { type: "string", minLength: 1, maxLength: 1200 },
    referencedOutputId: { anyOf: [{ type: "string", minLength: 1, maxLength: 160 }, { type: "null" }] }
  },
  required: ["thought", "source", "groundedObjective", "referencedOutputId"]
} as const;

const AlfredTurnGroundingOutputSchema: z.ZodType<AlfredTurnGroundingOutput> = z.object({
  thought: z.string().min(1).max(500),
  source: z.enum(["message", "recent_output", "recent_turn", "active_objective", "last_completed_run"]),
  groundedObjective: z.string().min(1).max(1200),
  referencedOutputId: z.string().min(1).max(160).nullable()
});

const ALFRED_TURN_INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    groundedObjective: { type: "string", minLength: 1, maxLength: 1200 },
    taskType: { type: "string", enum: ["lead_generation", "general"] },
    requiredDeliverable: { type: "string", minLength: 1, maxLength: 300 },
    hardConstraints: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 2, maxLength: 220 }
    },
    doneCriteria: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 2, maxLength: 260 }
    },
    assumptions: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 2, maxLength: 220 }
    },
    requiresDraft: { type: "boolean" },
    requiresCitations: { type: "boolean" },
    targetWordCount: { anyOf: [{ type: "integer", minimum: 100, maximum: 5000 }, { type: "null" }] },
    requestedOutputPath: { anyOf: [{ type: "string", minLength: 3, maxLength: 400 }, { type: "null" }] },
    clarificationNeeded: { type: "boolean" },
    clarificationQuestion: { anyOf: [{ type: "string", minLength: 1, maxLength: 1200 }, { type: "null" }] }
  },
  required: [
    "thought",
    "groundedObjective",
    "taskType",
    "requiredDeliverable",
    "hardConstraints",
    "doneCriteria",
    "assumptions",
    "requiresDraft",
    "requiresCitations",
    "targetWordCount",
    "requestedOutputPath",
    "clarificationNeeded",
    "clarificationQuestion"
  ]
} as const;

const AlfredTurnInterpretationOutputSchema: z.ZodType<AlfredTurnInterpretationOutput> = z.object({
  thought: z.string().min(1).max(500),
  groundedObjective: z.string().min(1).max(1200),
  taskType: z.enum(["lead_generation", "general"]),
  requiredDeliverable: z.string().min(1).max(300),
  hardConstraints: z.array(z.string().min(2).max(220)).max(10),
  doneCriteria: z.array(z.string().min(2).max(260)).max(10),
  assumptions: z.array(z.string().min(2).max(220)).max(8),
  requiresDraft: z.boolean(),
  requiresCitations: z.boolean(),
  targetWordCount: z.number().int().min(100).max(5000).nullable(),
  requestedOutputPath: z.string().min(3).max(400).nullable(),
  clarificationNeeded: z.boolean(),
  clarificationQuestion: z.string().min(1).max(1200).nullable()
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
  if (sessionContext.recentOutputs?.length) {
    const renderedOutputs = sessionContext.recentOutputs
      .slice(-3)
      .map((output) => {
        const artifactSuffix = output.artifactPath ? ` | artifact: ${output.artifactPath}` : "";
        return `- Recent output [${output.kind}/${output.availability}]: ${output.title} | ${output.summary}${artifactSuffix}`;
      });
    lines.push(...renderedOutputs);
  }
  if (sessionContext.activeThreadSummary) {
    lines.push(`- Active thread summary: ${sessionContext.activeThreadSummary}`);
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

function findSessionOutputById(
  sessionContext: SessionPromptContext | undefined,
  outputId: string | null | undefined
): SessionOutputRecord | null {
  if (!outputId) {
    return null;
  }
  const outputs = sessionContext?.recentOutputs ?? [];
  return outputs.find((output) => output.id === outputId) ?? null;
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
        "Treat this as the active task for this turn. Sessions can persist, but success criteria are based on the current turn unless user explicitly references prior work. The `turnState.objectiveContract` is immutable for this turn: do not weaken its hard constraints or done criteria. You have two capability catalogs at runtime: `availableTools` and `availableAgents`. Each tool includes `inputContract` with required fields, bounds, and an example payload: obey these strictly when choosing `toolInputJson` (for example, if `maxResults <= 15`, never exceed it). Choose strategy dynamically from the user ask and current evidence. You may execute directly with tools, delegate to a specialist agent, or respond if complete. Prefer direct execution when a small number of tool actions can likely complete the task; delegate when specialist iterative loops are likely higher-yield. Use `turnState.completionCriteria`, `turnState.completedCriteria`, `turnState.missingRequirements`, and `turnState.blockingIssues` as the canonical execution state for replanning. If `resolvedSessionOutput` is present, treat it as a reusable session asset. If `bodyPreview` is present, you may use it for lightweight continuation or transformation. If `artifactPath` is present and the exact stored body matters, call `file_read` before responding or revising. When `actionType=respond`, set `responseKind` explicitly: use `final` for a completed answer, `clarification` only when blocking ambiguity genuinely requires user input, and `progress` for interim guidance/status. Respect execution permission: if `executionPermission` is `plan_only`, return `actionType=respond` with plan guidance and no execution. Keep decisions prompt-driven; deterministic behavior should be limited to budget/safety guardrails."
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
        "Respond `shouldRespond=true` only when the latest successful tool or delegated agent result is sufficient to answer the current turn with reasonable honesty and the immutable `turnState.objectiveContract` done criteria are satisfied. Use `turnState.completedCriteria`, `turnState.missingRequirements`, and `turnState.blockingIssues` as the canonical checklist. If the result is partial, missing key evidence, or needs another action, set `shouldRespond=false` and explain exactly what is still missing. Keep this prompt-driven; do not invent facts beyond the observed result."
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
        "Use the current turn as the primary source of truth. Preserve explicit user requirements exactly. Do not inflate counts, broaden geography, or weaken required contact/output requirements. Prior session constraints are INACTIVE by default unless the user explicitly references them (for example: 'same as before', 'reuse previous constraints'). The brief is an execution contract for downstream specialist work, not a place to reinterpret the request."
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
  const normalizedMessage = collapseWhitespace(message).slice(0, 400);
  const emailRequired = containsAnyWord(message, ["email", "emails"]);
  const requestedLeadCount = parseLeadCountFromMessage(message) ?? 20;
  return {
    requestedLeadCount,
    emailRequired,
    outputFormat: containsAnyWord(message, ["csv"]) ? "csv" : null,
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

function parseIsoMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNumberField(source: unknown, keys: string[]): number | null {
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

function summarizeTopToolDurations(run: RunRecord): string {
  const top = [...run.toolCalls]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map((call) => `${call.toolName} (${call.durationMs}ms${call.status === "error" ? ", error" : ""})`);
  return top.length > 0 ? top.join(", ") : "none";
}

function getFinalAnswerPayload(events: RunEvent[]): Record<string, unknown> | null {
  for (const event of [...events].reverse()) {
    if (event.eventType === "final_answer") {
      return event.payload;
    }
  }
  return null;
}

function getAgentStopReason(events: RunEvent[]): string | null {
  for (const event of [...events].reverse()) {
    if (event.eventType === "agent_stop") {
      const reason = event.payload.reason;
      if (typeof reason === "string" && reason.trim()) {
        return reason.trim();
      }
    }
  }
  return null;
}

function buildDiagnosticResponse(run: RunRecord, events: RunEvent[]): string {
  const createdMs = parseIsoMs(run.createdAt);
  const updatedMs = parseIsoMs(run.updatedAt);
  const elapsedMs = createdMs !== null && updatedMs !== null ? Math.max(0, updatedMs - createdMs) : null;
  const okToolCalls = run.toolCalls.filter((call) => call.status === "ok").length;
  const errorToolCalls = run.toolCalls.filter((call) => call.status === "error").length;
  const finalPayload = getFinalAnswerPayload(events);
  const candidateCount =
    readNumberField(finalPayload, ["candidateCount", "finalCandidateCount"]) ??
    inferLeadFactsFromRunRecord(run).collectedLeadCount;
  const requestedLeadCount = readNumberField(finalPayload, ["requestedLeadCount"]);
  const stopReason = getAgentStopReason(events);
  const lines: string[] = [
    `Run diagnosis for ${run.runId}:`,
    `- Request: ${collapseWhitespace(run.message).slice(0, 220)}`,
    `- Status: ${run.status}${elapsedMs !== null ? ` (elapsed ${Math.round(elapsedMs / 1000)}s)` : ""}`,
    `- LLM usage: ${
      run.llmUsage
        ? `${run.llmUsage.totalTokens} tokens (prompt ${run.llmUsage.promptTokens}, completion ${run.llmUsage.completionTokens}) across ${run.llmUsage.callCount} calls`
        : "not recorded"
    }`,
    `- Tool calls: ${run.toolCalls.length} total (${okToolCalls} ok, ${errorToolCalls} error)`,
    `- Slowest tools: ${summarizeTopToolDurations(run)}`,
    `- Lead outcome: ${candidateCount}${requestedLeadCount !== null ? ` / ${requestedLeadCount}` : ""} collected`,
    `- Stop reason: ${stopReason ?? "not reported"}`
  ];
  if (run.artifactPaths?.length) {
    lines.push(`- Artifacts: ${run.artifactPaths.join(", ")}`);
  }
  if (run.assistantText) {
    lines.push(`- Final assistant summary: ${collapseWhitespace(run.assistantText).slice(0, 280)}`);
  }
  return lines.join("\n");
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

  return [`Answer the current turn directly and honestly: ${collapseWhitespace(message).slice(0, 240)}`];
}

function detectObjectiveTaskType(message: string, leadExecutionBrief?: LeadExecutionBrief | null): AlfredTaskType {
  if (leadExecutionBrief) {
    return "lead_generation";
  }
  if (
    containsAnyWord(message, [
      "research",
      "news",
      "blog",
      "article",
      "draft",
      "writeup",
      "source",
      "sources",
      "citation",
      "citations"
    ])
  ) {
    return "general";
  }
  return "general";
}

function parseFirstPositiveInt(token: string): number | null {
  const normalized = trimPunctuationEdges(token);
  if (!normalized) {
    return null;
  }
  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    if (code < 48 || code > 57) {
      return null;
    }
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseLeadCountFromMessage(message: string): number | null {
  const tokens = tokenizeLower(message);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const count = parseFirstPositiveInt(tokens[index] ?? "");
    if (!count) {
      continue;
    }
    const next = tokens[index + 1] ?? "";
    if (next === "lead" || next === "leads") {
      return count;
    }
  }
  return null;
}

function deriveHardConstraints(message: string): string[] {
  const constraints: string[] = [];
  const leadCount = parseLeadCountFromMessage(message);
  if (leadCount) {
    constraints.push(`Target lead count is ${leadCount}.`);
  }
  if (containsAnyWord(message, ["texas"])) {
    constraints.push("Geography includes Texas.");
  }
  if (containsAnyWord(message, ["usa", "us"]) || containsAnyPhrase(message, ["united states"])) {
    constraints.push("Geography includes USA.");
  }
  if (containsAnyWord(message, ["email", "emails"])) {
    constraints.push("Emails are required in the output.");
  }
  if (containsAnyWord(message, ["csv"])) {
    constraints.push("Deliverable must include CSV output.");
  }
  const targetWordCount = extractTargetWordCount(message);
  if (targetWordCount) {
    constraints.push(`Target word count is approximately ${targetWordCount}.`);
  }
  if (containsAnyWord(message, ["cite", "cited", "citation", "citations", "source", "sources"])) {
    constraints.push("Citations/sources are required.");
  }
  if (containsAnyWord(message, ["x", "twitter"])) {
    constraints.push("Include X/Twitter coverage when available.");
  }
  const outputPath = extractRequestedOutputPath(message);
  if (outputPath) {
    constraints.push(`Output must be saved to ${outputPath}.`);
  }
  return constraints;
}

function normalizeRequestedOutputPath(pathValue: string): string {
  let normalized = pathValue.trim();
  const trailing = ").,;:!?";
  while (normalized.length > 0 && trailing.includes(normalized[normalized.length - 1] ?? "")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function extractRequestedOutputPath(message: string): string | null {
  const tokens = collapseWhitespace(message)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const normalizedToken = normalizeRequestedOutputPath(token);
    if (normalizedToken.toLowerCase().startsWith("workspace/")) {
      return normalizedToken;
    }
  }
  return null;
}

function normalizePathForCompare(pathValue: string): string {
  let normalized = pathValue.split("\\").join("/").trim().toLowerCase();
  while (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = collapseWhitespace(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function buildObjectiveContract(
  message: string,
  leadExecutionBrief?: LeadExecutionBrief | null,
  interpretation?: AlfredTurnInterpretationOutput | null
): AlfredObjectiveContract {
  const taskType = detectObjectiveTaskType(message, leadExecutionBrief);
  const hardConstraints = deriveHardConstraints(message);
  const targetWordCountHint = interpretation?.targetWordCount ?? extractTargetWordCount(message);
  const requestedOutputPathHint = interpretation?.requestedOutputPath ?? extractRequestedOutputPath(message);
  const requiresCitations = interpretation?.requiresCitations
    ?? hardConstraints.some((item) => containsAnyWord(item, ["citation", "source"]));
  const requiresDraft = interpretation?.requiresDraft
    ?? containsAnyWord(message, ["blog", "post", "article", "draft", "write"]);
  const assumptions = interpretation?.assumptions ?? [];

  if (leadExecutionBrief) {
    const requiredDeliverable =
      leadExecutionBrief.outputFormat === "csv"
        ? `Produce ${leadExecutionBrief.requestedLeadCount} lead records and write them to CSV.`
        : `Produce ${leadExecutionBrief.requestedLeadCount} lead records.`;
    const doneCriteria = buildCompletionCriteria(message, leadExecutionBrief);
    return {
      taskType: interpretation?.taskType ?? taskType,
      requiredDeliverable,
      hardConstraints: dedupeStrings([
        ...hardConstraints,
        ...(interpretation?.hardConstraints ?? [])
      ]),
      softPreferences: [],
      doneCriteria: dedupeStrings([
        ...doneCriteria,
        ...(interpretation?.doneCriteria ?? [])
      ]),
      assumptions,
      requiresDraft,
      requiresCitations,
      targetWordCountHint,
      requestedOutputPathHint
    };
  }

  const requiredDeliverable = interpretation?.requiredDeliverable
    ?? (
      containsAnyWord(message, ["blog", "post"])
        ? "Deliver the requested blog draft with citations."
        : `Provide a complete response for: ${collapseWhitespace(message).slice(0, 180)}`
    );
  const doneCriteria = interpretation?.doneCriteria?.length
    ? interpretation.doneCriteria
    : [
        `Answer the current turn directly and honestly: ${collapseWhitespace(message).slice(0, 240)}`,
        ...(requiresCitations ? ["Include explicit source citations for factual claims."] : []),
        ...(requiresDraft ? ["Return the complete draft text in the requested format."] : [])
      ];
  return {
    taskType: interpretation?.taskType ?? taskType,
    requiredDeliverable,
    hardConstraints: interpretation?.hardConstraints?.length
      ? dedupeStrings(interpretation.hardConstraints)
      : hardConstraints,
    softPreferences: [],
    doneCriteria: dedupeStrings(doneCriteria),
    assumptions,
    requiresDraft,
    requiresCitations,
    targetWordCountHint,
    requestedOutputPathHint
  };
}

function extractTargetWordCount(message: string): number | null {
  const tokens = tokenizeLower(message);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const current = tokens[index] ?? "";
    const next = tokens[index + 1] ?? "";
    if (next !== "word" && next !== "words") {
      continue;
    }
    const normalizedCurrent = current.split("–").join("-");
    if (normalizedCurrent.includes("-")) {
      const parts = normalizedCurrent.split("-");
      if (parts.length === 2) {
        const lower = parseFirstPositiveInt(parts[0] ?? "");
        const upper = parseFirstPositiveInt(parts[1] ?? "");
        if (lower && upper) {
          return Math.round((lower + upper) / 2);
        }
      }
      continue;
    }
    const single = parseFirstPositiveInt(current);
    if (single) {
      return single;
    }
  }
  return null;
}

function buildSpecialistTaskContract(args: {
  agentName: string;
  message: string;
  objectiveContract: AlfredObjectiveContract;
  requestedOutputPath: string | null;
}): AgentTaskContract | undefined {
  const agentName = args.agentName.trim().toLowerCase();
  if (agentName !== "research_agent") {
    return undefined;
  }
  const requiresDraft = args.objectiveContract.requiresDraft;
  const requiresCitations = args.objectiveContract.requiresCitations;
  return {
    requiredDeliverable: args.objectiveContract.requiredDeliverable,
    requiresDraft,
    requiresCitations,
    minimumCitationCount: requiresCitations ? 2 : 0,
    doneCriteria: args.objectiveContract.doneCriteria,
    requestedOutputPath: args.requestedOutputPath ?? args.objectiveContract.requestedOutputPathHint,
    targetWordCount: args.objectiveContract.targetWordCountHint
  };
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

function summarizeRecentToolCalls(toolCalls: RunRecord["toolCalls"]): string {
  if (!toolCalls.length) {
    return "no recent tool calls";
  }
  return toolCalls
    .slice(-4)
    .map((call) => `${call.toolName}:${call.status}`)
    .join(", ");
}

function countBracketCitations(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const unique = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "[") {
      continue;
    }
    let cursor = index + 1;
    let digits = "";
    while (cursor < value.length) {
      const current = value[cursor] ?? "";
      const code = current.charCodeAt(0);
      if (code >= 48 && code <= 57) {
        digits += current;
        cursor += 1;
        continue;
      }
      break;
    }
    if (digits.length > 0 && value[cursor] === "]") {
      unique.add(digits);
      index = cursor;
    }
  }
  return unique.size;
}

function countUrlCitations(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const unique = new Set<string>();
  const stopChars = new Set([" ", "\n", "\t", "\r", ")", ">", "]"]);
  let index = 0;
  while (index < value.length) {
    const httpIndex = value.indexOf("http://", index);
    const httpsIndex = value.indexOf("https://", index);
    let start = -1;
    if (httpIndex >= 0 && httpsIndex >= 0) {
      start = Math.min(httpIndex, httpsIndex);
    } else {
      start = Math.max(httpIndex, httpsIndex);
    }
    if (start < 0) {
      break;
    }
    let cursor = start;
    while (cursor < value.length && !stopChars.has(value[cursor] ?? "")) {
      cursor += 1;
    }
    const url = value.slice(start, cursor).trim();
    if (url) {
      unique.add(url);
    }
    index = cursor + 1;
  }
  return unique.size;
}

function countWords(text: string | null | undefined): number {
  if (!text) {
    return 0;
  }
  return tokenizeLower(text).length;
}

function inferResearchFactsFromRunRecord(
  runRecord: RunRecord | undefined
): {
  draftWordCount: number;
  citationCount: number;
  fetchedPageCount: number;
  outputPath: string | null;
  writerFallback: boolean;
  writerFailureReason: string | null;
} {
  let draftWordCount = 0;
  let citationCount = 0;
  let fetchedPageCount = 0;
  let outputPath: string | null = null;
  let writerFallback = false;
  let writerFailureReason: string | null = null;
  const writerToolNames = new Set(["writer_agent", "article_writer"]);

  for (const toolCall of [...(runRecord?.toolCalls ?? [])].reverse()) {
    if (writerToolNames.has(toolCall.toolName) && toolCall.status === "ok") {
      const wordCount = findNumericField(toolCall.outputRedacted, ["wordCount"]) ?? 0;
      const content =
        toolCall.outputRedacted && typeof toolCall.outputRedacted === "object"
          ? typeof (toolCall.outputRedacted as Record<string, unknown>).content === "string"
            ? ((toolCall.outputRedacted as Record<string, unknown>).content as string)
            : null
          : null;
      const citationsFromContent = countBracketCitations(content);
      const outputPathValue =
        toolCall.outputRedacted && typeof toolCall.outputRedacted === "object"
          ? (toolCall.outputRedacted as Record<string, unknown>).outputPath
          : null;
      const fallbackUsedValue =
        toolCall.outputRedacted && typeof toolCall.outputRedacted === "object"
          ? (toolCall.outputRedacted as Record<string, unknown>).fallbackUsed
          : null;
      const failureReasonValue =
        toolCall.outputRedacted && typeof toolCall.outputRedacted === "object"
          ? (toolCall.outputRedacted as Record<string, unknown>).failureMessage
          : null;
      if (wordCount > draftWordCount) {
        draftWordCount = wordCount;
      }
      const citationsFromUrls = countUrlCitations(content);
      const citationSignal = Math.max(citationsFromContent, citationsFromUrls);
      if (citationSignal > citationCount) {
        citationCount = citationSignal;
      }
      if (typeof outputPathValue === "string" && outputPathValue.trim()) {
        outputPath = outputPathValue.trim();
      }
      if (fallbackUsedValue === true) {
        writerFallback = true;
      }
      if (!writerFailureReason && typeof failureReasonValue === "string" && failureReasonValue.trim()) {
        writerFailureReason = failureReasonValue.trim();
      }
    }
    if (toolCall.toolName === "web_fetch" && toolCall.status === "ok" && fetchedPageCount === 0) {
      fetchedPageCount = findNumericField(toolCall.outputRedacted, ["pagesFetched", "usablePageCount"]) ?? 0;
    }
  }

  return {
    draftWordCount,
    citationCount,
    fetchedPageCount,
    outputPath,
    writerFallback,
    writerFailureReason
  };
}

function summarizeDelegationOutcome(args: {
  agentName: string;
  leadOutcome: RunOutcome;
  runRecord?: RunRecord;
  recentToolCalls: RunRecord["toolCalls"];
}): string {
  const artifactsSeen = args.leadOutcome.artifactPaths?.length ?? args.runRecord?.artifactPaths?.length ?? 0;
  if (args.agentName === "research_agent") {
    const researchFacts = inferResearchFactsFromRunRecord(args.runRecord);
    const draftLine =
      researchFacts.draftWordCount > 0
        ? `Draft words: ${researchFacts.draftWordCount}.`
        : "No draft text produced yet.";
    const citationLine =
      researchFacts.citationCount > 0
        ? `Citation markers: ${researchFacts.citationCount}.`
        : "Citation markers: 0.";
    const writerStateLine = researchFacts.writerFallback
      ? `Writer fallback occurred${researchFacts.writerFailureReason ? ` (${researchFacts.writerFailureReason}).` : "."}`
      : "Writer completed without fallback.";
    const pathLine = researchFacts.outputPath
      ? `Output path: ${researchFacts.outputPath}.`
      : "No output file path was produced.";
    return [
      `${args.agentName} status: ${args.leadOutcome.status}.`,
      `Fetched pages: ${researchFacts.fetchedPageCount}.`,
      draftLine,
      citationLine,
      writerStateLine,
      pathLine,
      artifactsSeen > 0 ? `Artifacts available: ${artifactsSeen}.` : "No artifacts were produced.",
      `Recent tools: ${summarizeRecentToolCalls(args.recentToolCalls)}.`
    ].join(" ");
  }

  const delegatedFacts = inferLeadFactsFromRunRecord(args.runRecord);
  return [
    `${args.agentName} status: ${args.leadOutcome.status}.`,
    delegatedFacts.collectedLeadCount > 0
      ? `Leads found: ${delegatedFacts.collectedLeadCount}.`
      : "No completed lead records yet.",
    delegatedFacts.collectedEmailCount > 0
      ? `Emails found: ${delegatedFacts.collectedEmailCount}.`
      : "Email coverage is still low.",
    artifactsSeen > 0 ? `Artifacts available: ${artifactsSeen}.` : "No artifacts were produced.",
    `Recent tools: ${summarizeRecentToolCalls(args.recentToolCalls)}.`
  ].join(" ");
}

function summarizeToolOutput(toolName: string, output: unknown): string {
  if ((toolName === "writer_agent" || toolName === "article_writer") && output && typeof output === "object") {
    const payload = output as Record<string, unknown>;
    const wordCount = typeof payload.wordCount === "number" ? payload.wordCount : 0;
    const quality = typeof payload.draftQuality === "string" ? payload.draftQuality : "unknown";
    const path = typeof payload.outputPath === "string" ? payload.outputPath : null;
    const writerName = toolName === "article_writer" ? "article_writer" : "writer_agent";
    if (path) {
      return `${writerName} produced a ${quality} draft (${wordCount} words) at ${path}`;
    }
    return `${writerName} returned a ${quality} draft (${wordCount} words)`;
  }
  if (toolName === "file_write" && output && typeof output === "object") {
    const payload = output as Record<string, unknown>;
    const outputPath = typeof payload.outputPath === "string" ? payload.outputPath : null;
    if (outputPath) {
      return `file_write saved output to ${outputPath}`;
    }
  }
  return `${toolName} completed`;
}

function buildAlfredTurnState(args: {
  message: string;
  objectiveContract: AlfredObjectiveContract;
  leadExecutionBrief?: LeadExecutionBrief | null;
  leadState: LeadAgentState;
  lastAction: AlfredActionSnapshot | null;
  runRecord?: RunRecord;
}): AlfredTurnState {
  const requestedOutputPath = args.objectiveContract.requestedOutputPathHint;
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
  const availableArtifacts = Array.from(
    new Set([...(args.leadState.artifacts ?? []), ...(args.runRecord?.artifactPaths ?? [])])
  );
  const researchFacts = inferResearchFactsFromRunRecord(args.runRecord);
  const artifactMatchesRequestedPath = requestedOutputPath
    ? availableArtifacts.some((artifact) =>
        normalizePathForCompare(artifact).endsWith(normalizePathForCompare(requestedOutputPath))
      )
    : false;

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
      if (artifactMatchesRequestedPath || availableArtifacts.length > 0) {
        completedCriteria.push(`Requested output format is available (${canonicalLeadBrief.outputFormat}).`);
      } else {
        missingRequirements.push(`Need a ${canonicalLeadBrief.outputFormat} artifact before the task is complete.`);
      }
    }
  } else {
    const targetWordCount = args.objectiveContract.targetWordCountHint;
    const requiresDraft = args.objectiveContract.requiresDraft;
    const requiresCitations = args.objectiveContract.requiresCitations;
    const minimumDraftWords = targetWordCount
      ? Math.max(220, Math.floor(targetWordCount * 0.75))
      : 400;

    if (requestedOutputPath) {
      if (artifactMatchesRequestedPath) {
        completedCriteria.push(`Requested output path is available (${requestedOutputPath}).`);
      } else {
        missingRequirements.push(`Need the requested output saved at ${requestedOutputPath}.`);
      }
    }
    if (requiresDraft) {
      if (researchFacts.draftWordCount >= minimumDraftWords) {
        completedCriteria.push(`Draft length looks sufficient (${researchFacts.draftWordCount} words).`);
      } else {
        missingRequirements.push(
          `Need a fuller draft (${researchFacts.draftWordCount}/${minimumDraftWords} words observed).`
        );
      }
    }
    if (requiresCitations) {
      if (researchFacts.citationCount >= 2) {
        completedCriteria.push(`Citation evidence present (${researchFacts.citationCount}).`);
      } else {
        missingRequirements.push(`Need explicit citation evidence (observed ${researchFacts.citationCount}).`);
      }
    }
    const hasStrongPreexistingEvidence = missingRequirements.length === 0 && completedCriteria.length > 0;
    if (args.lastAction?.status !== "completed" && !hasStrongPreexistingEvidence) {
      missingRequirements.push("Need either a successful action result or a direct answer for the current turn.");
    }
  }

  if (args.lastAction?.status === "failed") {
    blockingIssues.push(`Last action failed: ${args.lastAction.summary}`);
  } else if (args.lastAction?.status === "cancelled") {
    blockingIssues.push(`Last action was cancelled: ${args.lastAction.summary}`);
  }

  return {
    turnObjective: args.message,
    taskType: args.objectiveContract.taskType,
    objectiveContract: args.objectiveContract,
    canonicalLeadBrief,
    completionCriteria: args.objectiveContract.doneCriteria,
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
      outputFormat: canonicalLeadBrief?.outputFormat ?? null,
      requestedOutputPath,
      draftWordCount: researchFacts.draftWordCount,
      citationCount: researchFacts.citationCount,
      resolvedOutputPath: researchFacts.outputPath
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

function looksLikeCitation(text: string): boolean {
  return text.includes("http://")
    || text.includes("https://")
    || containsAnyWord(text, ["source", "citation", "citations", "reference", "references"]);
}

function extractLeadCountHint(value: unknown): number {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : "";
  if (!text) {
    return 0;
  }
  return parseLeadCountFromMessage(text) ?? 0;
}

function evaluateCompletionContractGate(args: {
  evaluation: AlfredCompletionEvaluation;
  objectiveContract: AlfredObjectiveContract;
  turnState: AlfredTurnState;
  latestResult: unknown;
}): CompletionGateDecision {
  if (!args.evaluation.shouldRespond) {
    return { allowed: true };
  }

  if (args.turnState.taskType === "lead_generation") {
    const requested = args.turnState.facts.requestedLeadCount ?? 0;
    const factualCount = Math.max(
      args.turnState.facts.collectedLeadCount,
      extractLeadCountHint(args.latestResult),
      extractLeadCountHint(args.evaluation.responseText ?? "")
    );
    if (requested > 0 && factualCount < requested) {
      return {
        allowed: false,
        reason: `contract_not_satisfied: lead count ${factualCount}/${requested}`
      };
    }
    if (args.turnState.objectiveContract.hardConstraints.some((item) => containsAnyWord(item, ["email", "emails"]))) {
      const emailCovered =
        args.turnState.facts.collectedEmailCount >= Math.max(1, requested) ||
        containsAnyWord(JSON.stringify(args.latestResult ?? {}), ["email", "emails"]);
      if (!emailCovered) {
        return {
          allowed: false,
          reason: "contract_not_satisfied: required email coverage not met"
        };
      }
    }
    return { allowed: true };
  }

  const criticalMissingRequirement = args.turnState.missingRequirements.find((item) =>
    containsAnyPhrase(item.toLowerCase(), ["requested output saved", "artifact", "more leads", "email coverage", "required"])
  );
  if (criticalMissingRequirement) {
    return {
      allowed: false,
      reason: `contract_not_satisfied: ${criticalMissingRequirement}`
    };
  }

  const requiresCitations = args.objectiveContract.requiresCitations;
  if (requiresCitations) {
    const evidenceText = [
      args.evaluation.responseText ?? "",
      typeof args.latestResult === "string" ? args.latestResult : JSON.stringify(args.latestResult ?? {})
    ].join("\n");
    const citationSignals = Math.max(
      args.turnState.facts.citationCount,
      countBracketCitations(evidenceText),
      countUrlCitations(evidenceText)
    );
    if (citationSignals < 2 && !looksLikeCitation(evidenceText)) {
      return {
        allowed: false,
        reason: "contract_not_satisfied: citation evidence missing"
      };
    }
  }

  const requiresDraft = args.objectiveContract.requiresDraft;
  if (requiresDraft) {
    const targetWordCount = args.objectiveContract.targetWordCountHint;
    const minimumDraftWords = targetWordCount
      ? Math.max(220, Math.floor(targetWordCount * 0.75))
      : 400;
    const responseWordCount = countWords(args.evaluation.responseText);
    const evidenceWordCount = Math.max(args.turnState.facts.draftWordCount, responseWordCount);
    if (evidenceWordCount < minimumDraftWords) {
      return {
        allowed: false,
        reason: `contract_not_satisfied: draft content is incomplete (${evidenceWordCount}/${minimumDraftWords} words)`
      };
    }
  }

  return { allowed: true };
}

export async function runAlfredOrchestratorLoop(options: AlfredOrchestratorOptions): Promise<RunOutcome> {
  const startMs = Date.now();
  const deadlineAtMs = startMs + options.maxDurationMs;
  const structuredChatRunner = options.structuredChatRunner ?? openAiClient.runOpenAiStructuredChatWithDiagnostics;
  const turnMode = detectTurnMode(options.message);
  const executionPermission = detectExecutionPermission(options.message);
  const runtimeSession = await buildRuntimeSessionContext({
    sessionContext: options.sessionContext,
    runStore: options.runStore,
    sessionId: options.sessionId,
    excludeRunId: options.runId,
    recentOutputLimit: 6
  });
  const runtimeSessionContext = runtimeSession.sessionContext;
  const turnGrounding = turnMode === "diagnostic"
    ? {
        result: {
          thought: "Diagnostic slash-command preserves the current message without session grounding.",
          source: "message" as const,
          groundedObjective: options.message,
          referencedOutputId: null
        },
        fallback: {
          objective: options.message,
          source: "message" as const
        }
      }
    : await resolveTurnObjectiveWithSessionGrounding({
        apiKey: options.openAiApiKey,
        structuredChatRunner,
        message: options.message,
        sessionContext: runtimeSessionContext
      });
  if (turnGrounding.usage) {
    await options.runStore.addLlmUsage(options.runId, turnGrounding.usage, 1);
  }
  const resolvedTurnObjective = turnGrounding.result
    ? {
        objective: turnGrounding.result.groundedObjective,
        source: turnGrounding.result.source
      }
    : turnGrounding.fallback;
  const turnObjective = resolvedTurnObjective.objective;
  const turnInterpretation = turnMode === "diagnostic"
    ? null
    : await interpretTurnWithModel({
        apiKey: options.openAiApiKey,
        structuredChatRunner,
        originalMessage: options.message,
        groundedObjective: turnObjective,
        sessionContext: runtimeSessionContext
      });
  if (turnInterpretation?.usage) {
    await options.runStore.addLlmUsage(options.runId, turnInterpretation.usage, 1);
  }
  const interpretedTurn = turnInterpretation?.result ?? null;
  const resolvedSessionOutput = findSessionOutputById(runtimeSessionContext, turnGrounding.result?.referencedOutputId);
  const resolvedSessionOutputBodyPreview = await loadSessionOutputBodyPreview({
    workspaceDir: options.workspaceDir,
    output: resolvedSessionOutput,
    maxChars: 6_000
  });
  const discoveredTools = await discoverLeadAgentTools();
  const availableTools = discoveredTools;
  const availableToolSpecs = Array.from(availableTools.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputHint: tool.inputHint,
    inputContract: getToolInputContract(tool.name),
    requiresApproval: tool.requiresApproval === true
  }));
  const availableAgents = listAgentSkills().map((skill) => ({
    name: skill.name,
    description: skill.description,
    toolAllowlist: skill.toolAllowlist ?? []
  }));

  const alfredState: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: 0,
    fetchedPages: [],
    shortlistedUrls: [],
    researchSourceCards: []
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
  const setResearchSourceCards: LeadAgentToolContext["setResearchSourceCards"] = (cards) => {
    alfredState.researchSourceCards = cards;
  };
  const getResearchSourceCards: LeadAgentToolContext["getResearchSourceCards"] = () => alfredState.researchSourceCards ?? [];

  const toolContext: LeadAgentToolContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    message: turnObjective,
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
    getShortlistedUrls,
    setResearchSourceCards,
    getResearchSourceCards
  };

  const observations: Array<{ iteration: number; summary: string; outcome: string }> = [];
  let plannerCallsUsed = 0;
  let toolCallsUsed = 0;
  let lastDelegationSummary = "No delegation attempted yet.";
  let lastCompletionNote = "No completion evaluation yet.";
  let lastSuccessfulActionSummary: string | null = null;
  let lastAction: AlfredActionSnapshot | null = null;
  let latestRunRecord: RunRecord | undefined;
  let consecutivePlannerFailures = 0;
  const agentLoopRunner = options.agentLoopRunner ?? runAgentLoop;
  const scratchpad: Record<string, unknown> = {
    currentTurnObjective: turnObjective
  };
  const initialLeadBrief = looksLikeExecutableLeadRequest(turnObjective)
    ? await buildLeadExecutionBrief({
        apiKey: options.openAiApiKey,
        structuredChatRunner,
        message: turnObjective,
        sessionContext: runtimeSessionContext
      })
    : undefined;
  const objectiveContract = buildObjectiveContract(turnObjective, initialLeadBrief, interpretedTurn);
  const requestedOutputPath = objectiveContract.requestedOutputPathHint;
  scratchpad.currentObjectiveContract = objectiveContract;
  if (initialLeadBrief) {
    scratchpad.currentLeadExecutionBrief = initialLeadBrief;
    alfredState.executionBrief = initialLeadBrief;
    toolContext.leadExecutionBrief = initialLeadBrief;
  }
  const refreshTurnState = (): AlfredTurnState => {
    const turnState = buildAlfredTurnState({
      message: turnObjective,
      objectiveContract,
      leadExecutionBrief: (scratchpad.currentLeadExecutionBrief as LeadExecutionBrief | undefined) ?? undefined,
      leadState: alfredState,
      lastAction,
      runRecord: latestRunRecord
    });
    scratchpad.currentTurnState = turnState;
    return turnState;
  };
  latestRunRecord = await options.runStore.getRun(options.runId);
  refreshTurnState();
  const buildLeadAgentRuntimeOptions = (
    message: string,
    leadExecutionBrief?: LeadExecutionBrief,
    taskContract?: AgentTaskContract
  ): LeadAgentRuntimeOptions => ({
    scratchpad,
    leadExecutionBrief,
    taskContract,
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
      sessionContextLoaded: Boolean(runtimeSessionContext)
    },
    timestamp: nowIso()
  });
  if (runtimeSession.recoveredOutputs.length > 0) {
    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "alfred_session_outputs_recovered",
      payload: {
        recoveredCount: runtimeSession.recoveredOutputs.length,
        recoveredOutputIds: runtimeSession.recoveredOutputs.map((output) => output.id).slice(0, 6)
      },
      timestamp: nowIso()
    });
  }
  if (resolvedTurnObjective.source !== "message") {
    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "alfred_turn_objective_resolved",
      payload: {
        source: resolvedTurnObjective.source,
        originalMessage: options.message.slice(0, 240),
        resolvedTurnObjective: turnObjective.slice(0, 500)
      },
      timestamp: nowIso()
    });
  }
  if (interpretedTurn) {
    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "alfred_turn_interpreted",
      payload: {
        groundedObjective: interpretedTurn.groundedObjective,
        taskType: interpretedTurn.taskType,
        clarificationNeeded: interpretedTurn.clarificationNeeded,
        assumptions: interpretedTurn.assumptions
      },
      timestamp: nowIso()
    });
  }
  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "alfred_objective_contract_created",
    payload: {
      objectiveContract
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

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "alfred_turn_mode_selected",
    payload: {
      turnMode,
      executionPermission
    },
    timestamp: nowIso()
  });

  if (turnMode === "diagnostic") {
    const explicitRunId = extractRunIdFromMessage(options.message);
    const targetRunId = explicitRunId ?? runtimeSessionContext?.lastCompletedRun?.runId ?? runtimeSessionContext?.lastRunId;
    const targetRun = targetRunId ? await options.runStore.getRun(targetRunId) : undefined;
    const targetEvents = targetRun ? await options.runStore.listRunEvents(targetRun) : [];
    const diagnosticText = targetRun
      ? buildDiagnosticResponse(targetRun, targetEvents)
      : "No prior run evidence was found for this diagnostic request. Share a run id and I will analyze it directly.";

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "alfred_diagnostic_response",
      payload: {
        targetRunId: targetRunId ?? null,
        evidenceFound: Boolean(targetRun),
        eventCount: targetEvents.length
      },
      timestamp: nowIso()
    });

    return {
      status: "completed",
      assistantText: diagnosticText,
      artifactPaths: targetRun?.artifactPaths
    };
  }

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
          turnObjective,
          initialLeadBrief ??
            (await buildLeadExecutionBrief({
              apiKey: options.openAiApiKey,
              structuredChatRunner,
              message: turnObjective,
              sessionContext: runtimeSessionContext
            }))
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
            content: buildAlfredPlannerSystemPrompt(runtimeSessionContext)
          },
          {
            role: "user",
            content: JSON.stringify({
              turnObjective,
              executionPermission,
              turnInterpretation: interpretedTurn
                ? {
                    groundedObjective: interpretedTurn.groundedObjective,
                    assumptions: interpretedTurn.assumptions,
                    clarificationNeeded: interpretedTurn.clarificationNeeded,
                    clarificationQuestion: interpretedTurn.clarificationQuestion,
                    requiredDeliverable: interpretedTurn.requiredDeliverable,
                    doneCriteria: interpretedTurn.doneCriteria
                  }
                : null,
              objectiveContract,
              currentLeadExecutionBrief: (scratchpad.currentLeadExecutionBrief as LeadExecutionBrief | undefined) ?? null,
              turnState: refreshTurnState(),
              iteration,
              remainingMs: Math.max(0, deadlineAtMs - Date.now()),
              availableAgents,
              availableTools: availableToolSpecs,
              resolvedSessionOutput: resolvedSessionOutput
                ? {
                    id: resolvedSessionOutput.id,
                    kind: resolvedSessionOutput.kind,
                    title: resolvedSessionOutput.title,
                    summary: resolvedSessionOutput.summary,
                    availability: resolvedSessionOutput.availability,
                    artifactPath: resolvedSessionOutput.artifactPath ?? null,
                    contentPreview: resolvedSessionOutput.contentPreview ?? null,
                    bodyPreview: resolvedSessionOutputBodyPreview?.content ?? null,
                    bodyPreviewTruncated: resolvedSessionOutputBodyPreview?.truncated ?? false,
                    metadata: resolvedSessionOutput.metadata ?? null
                  }
                : null,
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
      consecutivePlannerFailures += 1;
      const failureClass = plannerDiagnostic.failureClass ?? classifyStructuredFailure(plannerDiagnostic);
      const failureMessage = plannerDiagnostic.failureMessage?.slice(0, 220) ?? "planner_failed";
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "alfred_planner_failed",
        payload: {
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
          assistantText: `Alfred is blocked by policy/auth settings: ${failureMessage}`
        };
      }
      if (failureClass === "network" || failureClass === "timeout") {
        const delayMs = computeRetryDelayMs(
          consecutivePlannerFailures,
          {
            maxAttempts: 4,
            baseDelayMs: 200,
            maxDelayMs: 1600,
            jitterRatio: 0.2
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

    let plan = plannerDiagnostic.result;
    const planOnlyGuardrailTriggered = executionPermission === "plan_only" && plan.actionType !== "respond";
    if (planOnlyGuardrailTriggered) {
      plan = {
        ...plan,
        thought: `${plan.thought} (adjusted: executionPermission=plan_only)`,
        actionType: "respond",
        delegateAgent: null,
        delegateBrief: null,
        toolName: null,
        toolInputJson: null,
        responseText: buildPlanOnlyResponse(plan, turnObjective)
      };
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "alfred_plan_adjusted",
        payload: {
          iteration,
          reason: "execution_permission_plan_only",
          originalActionType: plannerDiagnostic.result.actionType,
          adjustedActionType: plan.actionType
        },
        timestamp: nowIso()
      });
    }
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
        responseKind: plan.responseKind,
        delegateAgent: plan.delegateAgent,
        toolName: plan.toolName,
        turnState: refreshTurnState()
      },
      timestamp: nowIso()
    });

    if (plan.actionType === "respond") {
      const responseKind = plan.responseKind ?? "final";
      if (responseKind === "clarification") {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "alfred_clarification_requested",
          payload: {
            source: "planner_response",
            question: plan.responseText ?? ""
          },
          timestamp: nowIso()
        });
      }
      if (
        executionPermission !== "plan_only" &&
        responseKind === "final"
      ) {
        const respondGate = evaluateCompletionContractGate({
          evaluation: {
            thought: plan.thought,
            shouldRespond: true,
            responseText: plan.responseText,
            continueReason: null,
            confidence: 1
          },
          objectiveContract,
          turnState: refreshTurnState(),
          latestResult: {
            planAction: "respond",
            responseText: plan.responseText
          }
        });
        if (!respondGate.allowed) {
          await options.runStore.appendEvent({
            runId: options.runId,
            sessionId: options.sessionId,
            phase: "thought",
            eventType: "alfred_completion_contract_blocked",
            payload: {
              iteration,
              actionSummary: "respond",
              reason: respondGate.reason ?? "contract_not_satisfied"
            },
            timestamp: nowIso()
          });
          observations.push({
            iteration,
            summary: "completion_eval:continue",
            outcome: (respondGate.reason ?? "contract_not_satisfied").slice(0, 260)
          });
          lastCompletionNote = `Completion evaluator: continue gathering. ${respondGate.reason ?? "contract_not_satisfied"}`;
          continue;
        }
      }
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

      const delegatedMessage = (plan.delegateBrief ?? turnObjective).slice(0, 1200);
      const delegatedTaskContract = buildSpecialistTaskContract({
        agentName,
        message: turnObjective,
        objectiveContract,
        requestedOutputPath
      });
      const leadExecutionBrief = agentName === "lead_agent"
        ? await buildLeadExecutionBrief({
            apiKey: options.openAiApiKey,
            structuredChatRunner,
            message: delegatedMessage,
            sessionContext: runtimeSessionContext
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
          skill: agentName,
          agentName,
          brief: delegatedMessage,
          leadExecutionBrief,
          taskContract: delegatedTaskContract,
          scratchpadKeys: Object.keys(scratchpad).sort()
        },
        timestamp: nowIso()
      });
      const leadOutcome = await agentLoopRunner({
        skillName: agentName,
        parentRunId: options.runId,
        delegationId,
        ...buildLeadAgentRuntimeOptions(delegatedMessage, leadExecutionBrief, delegatedTaskContract)
      });
      scratchpad[`delegation.${delegationId}.result`] = {
        status: leadOutcome.status,
        assistantText: (leadOutcome.assistantText ?? "").slice(0, 400),
        artifactPaths: leadOutcome.artifactPaths ?? []
      };
      const runRecord = await options.runStore.getRun(options.runId);
      latestRunRecord = runRecord ?? latestRunRecord;
      const runEvents = runRecord ? await options.runStore.listRunEvents(runRecord) : [];
      const stopReason = getAgentStopReason(runEvents);
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
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "agent_delegation_result",
        payload: {
          iteration,
          delegationId,
          skill: agentName,
          agentName,
          status: leadOutcome.status,
          assistantText: (leadOutcome.assistantText ?? "").slice(0, 500),
          artifactCount: leadOutcome.artifactPaths?.length ?? 0,
          artifactPaths: leadOutcome.artifactPaths ?? [],
          stopReason,
          scratchpadKeys: Object.keys(scratchpad).sort()
        },
        timestamp: nowIso()
      });

      lastDelegationSummary = summarizeDelegationOutcome({
        agentName,
        leadOutcome,
        runRecord: runRecord ?? undefined,
        recentToolCalls
      });
      lastSuccessfulActionSummary = lastDelegationSummary;
      const delegationEvidence = recentToolCalls.map((call) => ({
        toolName: call.toolName,
        status: call.status,
        durationMs: call.durationMs,
        output: truncateForPrompt(call.outputRedacted, 600)
      }));
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
        summary: `delegate_${agentName}`,
        outcome: lastDelegationSummary.slice(0, 500)
      });

      if (leadOutcome.status === "cancelled") {
        return leadOutcome;
      }

      if (plannerCallsUsed < options.plannerMaxCalls) {
        const completionDiagnostic = await runCompletionEvaluator({
          apiKey: options.openAiApiKey,
          structuredChatRunner,
          message: turnObjective,
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
            artifactPaths: leadOutcome.artifactPaths,
            delegationEvidence
          },
          sessionContext: runtimeSessionContext
        });
        plannerCallsUsed += 1;
        if (completionDiagnostic.usage) {
          await options.runStore.addLlmUsage(options.runId, completionDiagnostic.usage, 1);
        }
        const completionResult = completionDiagnostic.result;
        if (completionResult) {
          const completionGate = evaluateCompletionContractGate({
            evaluation: completionResult,
            objectiveContract,
            turnState: delegatedTurnState,
            latestResult: {
              status: leadOutcome.status,
              assistantText: leadOutcome.assistantText,
              artifactPaths: leadOutcome.artifactPaths,
              delegationEvidence
            }
          });
          if (!completionGate.allowed) {
            completionResult.shouldRespond = false;
            completionResult.continueReason = completionGate.reason ?? completionResult.continueReason;
            await options.runStore.appendEvent({
              runId: options.runId,
              sessionId: options.sessionId,
              phase: "thought",
              eventType: "alfred_completion_contract_blocked",
              payload: {
                iteration,
                actionSummary: `delegate_agent:${agentName}`,
                reason: completionGate.reason ?? "contract_not_satisfied"
              },
              timestamp: nowIso()
            });
          }
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
      if (tool.requiresApproval === true) {
        lastAction = {
          iteration,
          actionType: "call_tool",
          name: toolName,
          status: "failed",
          summary: "tool_requires_approval"
        };
        observations.push({
          iteration,
          summary: `tool_requires_approval:${toolName}`,
          outcome: "tool requires explicit approval"
        });
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "observe",
          eventType: "alfred_tool_requires_approval",
          payload: {
            iteration,
            toolName
          },
          timestamp: nowIso()
        });
        continue;
      }

      const input = parseToolInputJson(plan.toolInputJson ?? "{}");
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
        lastSuccessfulActionSummary = summarizeToolOutput(toolName, output);
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
          message: turnObjective,
          leadExecutionBrief: undefined,
          iteration,
          remainingMs: Math.max(0, deadlineAtMs - Date.now()),
          turnState: postToolTurnState,
          recentObservations: observations,
          lastDelegationSummary,
          actionSummary: `call_tool:${toolName}`,
          latestResult: latestToolOutput,
          sessionContext: runtimeSessionContext
        });
        plannerCallsUsed += 1;
        if (completionDiagnostic.usage) {
          await options.runStore.addLlmUsage(options.runId, completionDiagnostic.usage, 1);
        }
        const completionResult = completionDiagnostic.result;
        if (completionResult) {
          const completionGate = evaluateCompletionContractGate({
            evaluation: completionResult,
            objectiveContract,
            turnState: postToolTurnState,
            latestResult: latestToolOutput
          });
          if (!completionGate.allowed) {
            completionResult.shouldRespond = false;
            completionResult.continueReason = completionGate.reason ?? completionResult.continueReason;
            await options.runStore.appendEvent({
              runId: options.runId,
              sessionId: options.sessionId,
              phase: "thought",
              eventType: "alfred_completion_contract_blocked",
              payload: {
                iteration,
                actionSummary: `call_tool:${toolName}`,
                reason: completionGate.reason ?? "contract_not_satisfied"
              },
              timestamp: nowIso()
            });
          }
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

  const fallbackText = lastSuccessfulActionSummary
    ? `I hit budget/iteration guardrails before fully completing this request. Last meaningful progress: ${lastSuccessfulActionSummary}`
    : lastDelegationSummary !== "No delegation attempted yet."
      ? `I stopped due to budget/iteration guardrails. Latest specialist result: ${lastDelegationSummary}`
      : "I stopped due to budget/iteration guardrails before producing a conclusive result.";
  return {
    status: "completed",
    assistantText: fallbackText,
    artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
  };
}
