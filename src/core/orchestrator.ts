import type { PolicyMode, RunOutcome, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { LeadAgentDefaults } from "../agent/types.js";
import type { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import { ALFRED_AGENT } from "./specialists.js";
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

function nowIso(): string {
  return new Date().toISOString();
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

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "route",
    eventType: "specialist_selected",
    payload: { specialist: ALFRED_AGENT.name, classifyMs: 0 },
    timestamp: nowIso()
  });

  const outcome = await runAgentLoop({
    runId,
    sessionId,
    message,
    model: ALFRED_AGENT.model,
    systemPrompt: ALFRED_AGENT.systemPrompt,
    toolAllowlist: ALFRED_AGENT.toolAllowlist,
    maxIterations: ALFRED_AGENT.maxIterations,
    maxDurationMs,
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

  return { ...outcome, specialist: ALFRED_AGENT.name };
}
