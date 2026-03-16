import type { PolicyMode, RunOutcome, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import { evaluateApprovalNeed } from "./approvalPolicy.js";
import { appendDailyNote } from "../memory/dailyNotes.js";
import { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import { runAlfredOrchestratorLoop } from "./runAlfredOrchestratorLoop.js";

interface RunReActLoopOptions {
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  policyMode: PolicyMode;
  searchMaxResults: number;
  fastScrapeCount: number;
  enablePlaywright: boolean;
  maxSteps: number;
  openAiApiKey?: string;
  subReactMaxPages: number;
  subReactBrowseConcurrency: number;
  subReactBatchSize: number;
  subReactLlmMaxCalls: number;
  subReactMinConfidence: number;
  leadPipelineExecutor?: typeof executeLeadSubReactPipeline;
  agentMaxDurationMs?: number;
  agentMaxToolCalls?: number;
  agentMaxParallelTools?: number;
  agentPlannerMaxCalls?: number;
  agentObservationWindow?: number;
  agentDiminishingThreshold?: number;
  sessionContext?: SessionPromptContext;
  isCancellationRequested: () => Promise<boolean>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function runReActLoop(
  sessionId: string,
  message: string,
  runId: string,
  options: RunReActLoopOptions
): Promise<RunOutcome> {
  const { runStore } = options;

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "session",
    eventType: "loop_started",
    payload: { maxSteps: options.maxSteps },
    timestamp: nowIso()
  });

  if (options.sessionContext) {
    await runStore.appendEvent({
      runId,
      sessionId,
      phase: "session",
      eventType: "session_context_loaded",
      payload: {
        hasActiveObjective: Boolean(options.sessionContext.activeObjective),
        hasLastCompletedRun: Boolean(options.sessionContext.lastCompletedRun?.runId),
        artifactCount: options.sessionContext.lastArtifacts?.length ?? options.sessionContext.lastCompletedRun?.artifactPaths?.length ?? 0,
        hasSessionSummary: Boolean(options.sessionContext.sessionSummary),
        recentTurnCount: options.sessionContext.recentTurns?.length ?? 0,
        recentOutputCount: options.sessionContext.recentOutputs?.length ?? 0
      },
      timestamp: nowIso()
    });
  }

  await appendDailyNote(options.workspaceDir, sessionId, "user", message);

  const approval = evaluateApprovalNeed(message, options.policyMode);
  if (approval.needed) {
    await runStore.appendEvent({
      runId,
      sessionId,
      phase: "approval",
      eventType: "approval_required",
      payload: { reason: approval.reason, token: approval.token },
      timestamp: nowIso()
    });

    return {
      status: "needs_approval",
      approvalToken: approval.token,
      assistantText: `Approval required (${approval.token}) before executing this request.`
    };
  }

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "thought",
    eventType: "intent_identified",
    payload: { intent: "master_orchestration" },
    timestamp: nowIso()
  });

  const leadPipelineExecutor = options.leadPipelineExecutor ?? executeLeadSubReactPipeline;
  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    message,
    runId,
    sessionId,
    openAiApiKey: options.openAiApiKey,
    defaults: {
      searchMaxResults: options.searchMaxResults,
      subReactMaxPages: options.subReactMaxPages,
      subReactBrowseConcurrency: options.subReactBrowseConcurrency,
      subReactBatchSize: options.subReactBatchSize,
      subReactLlmMaxCalls: options.subReactLlmMaxCalls,
      subReactMinConfidence: options.subReactMinConfidence
    },
    leadPipelineExecutor,
    maxIterations: options.maxSteps,
    maxDurationMs: options.agentMaxDurationMs ?? 240000,
    maxToolCalls: options.agentMaxToolCalls ?? Math.max(8, options.maxSteps * 3),
    maxParallelTools: options.agentMaxParallelTools ?? 3,
    plannerMaxCalls: options.agentPlannerMaxCalls ?? Math.max(3, options.maxSteps),
    observationWindow: options.agentObservationWindow ?? 8,
    diminishingThreshold: options.agentDiminishingThreshold ?? 2,
    policyMode: options.policyMode,
    sessionContext: options.sessionContext,
    isCancellationRequested: options.isCancellationRequested
  });

  await appendDailyNote(options.workspaceDir, sessionId, "assistant", outcome.assistantText ?? "");
  return outcome;
}
