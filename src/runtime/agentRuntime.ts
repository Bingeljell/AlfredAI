import type { EffectiveModelSelection, PolicyMode, RunOutcome, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { SchedulerTaskApi } from "../scheduler/api.js";
import type { SchedulerProvenance } from "../scheduler/notifier.js";
import type { SchedulerTurnControl } from "../scheduler/api.js";
import type { TurnExecutionProfile } from "./executionProfile.js";
import { getPolicyMode } from "../config/env.js";
import { runReActLoop } from "./runReActLoop.js";
import { SCHEDULER_SYSTEM_PROMPT } from "../scheduler/execution.js";

export interface AgentTurnRequest {
  runId: string;
  sessionId: string;
  message: string;
  sessionContext?: SessionPromptContext;
  provenance?: SchedulerProvenance;
  executionProfile?: TurnExecutionProfile;
  schedulerControl?: SchedulerTurnControl;
  modelSelection?: EffectiveModelSelection;
}

export interface AgentRuntimeServices {
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  searchMaxResults: number;
  fastScrapeCount: number;
  enablePlaywright: boolean;
  maxSteps: number;
  openAiApiKey?: string;
  browseConcurrency: number;
  pinchtabBaseUrl?: string;
  agentMaxDurationMs: number;
  agentMaxToolCalls: number;
  agentMaxParallelTools: number;
  runLoopRunner?: typeof runReActLoop;
  scheduler?: SchedulerTaskApi;
}

export interface AgentRuntime {
  runTurn(request: AgentTurnRequest): Promise<RunOutcome>;
}

/**
 * The current Alfred runtime. It owns the legacy ReAct orchestration behind a
 * provider-neutral turn boundary so ChatService does not select an LLM
 * transport or construct provider-facing conversations.
 */
export class AlfredAgentRuntime implements AgentRuntime {
  constructor(private readonly services: AgentRuntimeServices) {}

  async runTurn(request: AgentTurnRequest): Promise<RunOutcome> {
    const { services } = this;
    const runLoopRunner = services.runLoopRunner ?? runReActLoop;
    return runLoopRunner(request.sessionId, request.message, request.runId, {
      runStore: services.runStore,
      searchManager: services.searchManager,
      workspaceDir: services.workspaceDir,
      policyMode: getPolicyMode(),
      searchMaxResults: services.searchMaxResults,
      fastScrapeCount: services.fastScrapeCount,
      enablePlaywright: services.enablePlaywright,
      maxSteps: services.maxSteps,
      openAiApiKey: services.openAiApiKey,
      browseConcurrency: services.browseConcurrency,
      pinchtabBaseUrl: services.pinchtabBaseUrl,
      agentMaxDurationMs: services.agentMaxDurationMs,
      agentMaxToolCalls: services.agentMaxToolCalls,
      agentMaxParallelTools: services.agentMaxParallelTools,
      sessionContext: request.sessionContext,
      isCancellationRequested: () => services.runStore.isCancellationRequested(request.runId),
      scheduler: services.scheduler,
      provenance: request.provenance,
      executionProfile: request.executionProfile,
      schedulerControl: request.schedulerControl,
      systemPrompt: request.executionProfile?.origin === "scheduler" ? SCHEDULER_SYSTEM_PROMPT : undefined
    });
  }
}
