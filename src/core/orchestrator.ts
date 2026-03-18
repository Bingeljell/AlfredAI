import { z } from "zod";
import type { PolicyMode, RunOutcome, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { LeadAgentDefaults } from "../agent/types.js";
import type { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import { runOpenAiStructuredChatWithDiagnostics } from "../services/openAiClient.js";
import { getSpecialistConfig } from "./specialists.js";
import { runAgentLoop } from "./agentLoop.js";

export interface OrchestratorOptions {
  runId: string;
  sessionId: string;
  message: string;
  openAiApiKey?: string;
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  defaults: LeadAgentDefaults;
  leadPipelineExecutor: typeof executeLeadSubReactPipeline;
  maxDurationMs: number;
  policyMode: PolicyMode;
  sessionContext?: SessionPromptContext;
  isCancellationRequested: () => Promise<boolean>;
}

type SpecialistName = "research" | "writing" | "lead" | "ops";

const ClassificationSchema = z.object({
  specialist: z.enum(["research", "writing", "lead", "ops"]),
  reasoning: z.string()
});

const CLASSIFICATION_SYSTEM_PROMPT = `You are a task classifier. Given a user message, determine which specialist agent should handle it.

Specialists:
- research: Answering questions, finding information, building lists, comparisons, lookups, research tasks. Use when the user wants to find or learn something.
- writing: Producing written content — blog posts, articles, emails, memos, social posts, outlines, rewrites. Use when the user wants a drafted document.
- lead: Finding business leads, contacts, companies, email addresses, prospect lists. Use when the user wants a list of companies or contacts.
- ops: File operations, shell commands, running scripts, managing processes, workspace management. Use when the user wants to do something on the filesystem or run code.

Output a JSON object with "specialist" (one of: research, writing, lead, ops) and "reasoning" (one sentence).`;

function nowIso(): string {
  return new Date().toISOString();
}

async function classifyTask(
  message: string,
  apiKey: string | undefined,
  sessionContext: SessionPromptContext | undefined
): Promise<SpecialistName> {
  if (!apiKey) {
    // Default to research if no API key (will fail later with a clear error)
    return "research";
  }

  // Quick heuristics to skip the LLM call for obvious cases
  const lower = message.toLowerCase();
  if (/\b(lead|leads|prospect|contact|email.{0,20}compan|compan.{0,20}email|find.{0,30}compan|list.{0,30}compan)\b/.test(lower)) {
    return "lead";
  }
  if (/\b(write|draft|article|blog|post|memo|email.{0,20}write|write.{0,20}email|outline|newsletter)\b/.test(lower)) {
    return "writing";
  }
  if (/\b(run|exec|shell|file|folder|directory|script|process|install|mkdir|ls|cat|grep|terminal)\b/.test(lower)) {
    return "ops";
  }

  const userContent = sessionContext?.activeObjective
    ? `User objective context: ${sessionContext.activeObjective}\n\nUser message: ${message}`
    : message;

  const result = await runOpenAiStructuredChatWithDiagnostics(
    {
      apiKey,
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: CLASSIFICATION_SYSTEM_PROMPT },
        { role: "user", content: userContent }
      ],
      schemaName: "TaskClassification",
      jsonSchema: {
        type: "object",
        properties: {
          specialist: { type: "string", enum: ["research", "writing", "lead", "ops"] },
          reasoning: { type: "string" }
        },
        required: ["specialist", "reasoning"],
        additionalProperties: false
      },
      timeoutMs: 10_000,
      maxAttempts: 2
    },
    ClassificationSchema
  );

  return (result.result?.specialist as SpecialistName) ?? "research";
}

export async function runOrchestrator(options: OrchestratorOptions): Promise<RunOutcome> {
  const {
    runId,
    sessionId,
    message,
    openAiApiKey,
    runStore,
    searchManager,
    workspaceDir,
    defaults,
    leadPipelineExecutor,
    maxDurationMs,
    policyMode,
    sessionContext,
    isCancellationRequested
  } = options;

  const classifyStart = Date.now();
  const specialistName = await classifyTask(message, openAiApiKey, sessionContext);
  const classifyMs = Date.now() - classifyStart;

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "route",
    eventType: "specialist_selected",
    payload: { specialist: specialistName, classifyMs },
    timestamp: nowIso()
  });

  const spec = getSpecialistConfig(specialistName);

  return runAgentLoop({
    runId,
    sessionId,
    message,
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    toolAllowlist: spec.toolAllowlist,
    maxIterations: spec.maxIterations,
    maxDurationMs: maxDurationMs - classifyMs,
    openAiApiKey,
    runStore,
    searchManager,
    workspaceDir,
    defaults,
    leadPipelineExecutor,
    policyMode,
    sessionContext,
    isCancellationRequested
  });
}
