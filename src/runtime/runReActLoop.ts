import type { PolicyMode, RunOutcome, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import { evaluateApprovalNeed } from "./approvalPolicy.js";
import { ALFRED_AGENT } from "./specialists.js";
import { runAgentLoop } from "./agentLoop.js";
import type { SchedulerTaskApi } from "../scheduler/api.js";
import type { SchedulerProvenance } from "../scheduler/notifier.js";
import type { SchedulerTurnControl } from "../scheduler/api.js";
import type { TurnExecutionProfile } from "./executionProfile.js";

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
  browseConcurrency: number;
  pinchtabBaseUrl?: string;
  agentMaxDurationMs?: number;
  agentMaxToolCalls?: number;
  agentMaxParallelTools?: number;
  sessionContext?: SessionPromptContext;
  isCancellationRequested: () => Promise<boolean>;
  scheduler?: SchedulerTaskApi;
  provenance?: SchedulerProvenance;
  executionProfile?: TurnExecutionProfile;
  schedulerControl?: SchedulerTurnControl;
  systemPrompt?: string;
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
        artifactCount:
          options.sessionContext.lastArtifacts?.length ??
          options.sessionContext.lastCompletedRun?.artifactPaths?.length ??
          0,
        hasSessionSummary: Boolean(options.sessionContext.sessionSummary),
        recentTurnCount: options.sessionContext.recentTurns?.length ?? 0,
        recentOutputCount: options.sessionContext.recentOutputs?.length ?? 0
      },
      timestamp: nowIso()
    });
  }

  const approval = options.executionProfile?.origin === "scheduler"
    ? { needed: false as const }
    : evaluateApprovalNeed(message, options.policyMode);
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

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "route",
    eventType: "specialist_selected",
    payload: { specialist: ALFRED_AGENT.name, classifyMs: 0 },
    timestamp: nowIso()
  });

  const agentOutcome = await runAgentLoop({
    runId,
    sessionId,
    message,
    model: ALFRED_AGENT.model,
    maxIterations: options.executionProfile?.maxIterations ?? ALFRED_AGENT.maxIterations,
    maxDurationMs: options.executionProfile?.maxDurationMs ?? options.agentMaxDurationMs ?? 240_000,
    maxToolCalls: options.executionProfile?.maxToolCalls ?? options.agentMaxToolCalls ?? 18,
    toolAllowlist: options.executionProfile?.toolAllowlist ?? ALFRED_AGENT.toolAllowlist,
    systemPrompt: options.systemPrompt ?? ALFRED_AGENT.systemPrompt,
    openAiApiKey: options.openAiApiKey,
    enablePlaywright: options.enablePlaywright,
    pinchtabBaseUrl: options.pinchtabBaseUrl,
    runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    defaults: {
      searchMaxResults: options.searchMaxResults,
      browseConcurrency: options.browseConcurrency
    },
    policyMode: options.policyMode,
    sessionContext: options.sessionContext,
    isCancellationRequested: options.isCancellationRequested,
    scheduler: options.scheduler,
    provenance: options.provenance,
    executionProfile: options.executionProfile,
    schedulerControl: options.schedulerControl
  });

  const outcome: RunOutcome = { ...agentOutcome, specialist: ALFRED_AGENT.name };

  return outcome;
}
