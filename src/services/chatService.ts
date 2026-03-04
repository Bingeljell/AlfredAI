import type { RunOutcome, RunStatus } from "../types.js";
import { runReActLoop } from "../core/runReActLoop.js";
import type { SessionStore } from "../memory/sessionStore.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { InMemoryQueue } from "../workers/inMemoryQueue.js";
import { getPolicyMode } from "../config/env.js";

interface ChatTurnInput {
  sessionId: string;
  message: string;
  requestJob?: boolean;
}

interface ChatServiceOptions {
  sessionStore: SessionStore;
  runStore: RunStore;
  searchManager: SearchManager;
  queue: InMemoryQueue;
  workspaceDir: string;
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
  agentMaxDurationMs: number;
  agentMaxToolCalls: number;
  agentMaxParallelTools: number;
  agentPlannerMaxCalls: number;
  agentObservationWindow: number;
  agentDiminishingThreshold: number;
}

export class ChatService {
  constructor(private readonly options: ChatServiceOptions) {}

  private async executeRun(runId: string, sessionId: string, message: string): Promise<RunOutcome> {
    if (await this.options.runStore.isCancellationRequested(runId)) {
      await this.options.runStore.appendEvent({
        runId,
        sessionId,
        phase: "final",
        eventType: "cancelled",
        payload: { reason: "cancel_requested_before_start" },
        timestamp: new Date().toISOString()
      });
      await this.options.runStore.updateRun(runId, {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
        assistantText: "Run cancelled before execution started."
      });
      return {
        status: "cancelled",
        assistantText: "Run cancelled before execution started."
      };
    }

    await this.options.runStore.updateRun(runId, { status: "running" });
    const startedAt = Date.now();
    const heartbeatTimer = setInterval(() => {
      void this.options.runStore.appendEvent({
        runId,
        sessionId,
        phase: "observe",
        eventType: "heartbeat",
        payload: {
          status: "running",
          elapsedMs: Date.now() - startedAt
        },
        timestamp: new Date().toISOString()
      });
    }, 10_000);
    heartbeatTimer.unref?.();

    try {
      const outcome = await runReActLoop(sessionId, message, runId, {
        runStore: this.options.runStore,
        searchManager: this.options.searchManager,
        workspaceDir: this.options.workspaceDir,
        policyMode: getPolicyMode(),
        searchMaxResults: this.options.searchMaxResults,
        fastScrapeCount: this.options.fastScrapeCount,
        enablePlaywright: this.options.enablePlaywright,
        maxSteps: this.options.maxSteps,
        openAiApiKey: this.options.openAiApiKey,
        subReactMaxPages: this.options.subReactMaxPages,
        subReactBrowseConcurrency: this.options.subReactBrowseConcurrency,
        subReactBatchSize: this.options.subReactBatchSize,
        subReactLlmMaxCalls: this.options.subReactLlmMaxCalls,
        subReactMinConfidence: this.options.subReactMinConfidence,
        agentMaxDurationMs: this.options.agentMaxDurationMs,
        agentMaxToolCalls: this.options.agentMaxToolCalls,
        agentMaxParallelTools: this.options.agentMaxParallelTools,
        agentPlannerMaxCalls: this.options.agentPlannerMaxCalls,
        agentObservationWindow: this.options.agentObservationWindow,
        agentDiminishingThreshold: this.options.agentDiminishingThreshold,
        isCancellationRequested: () => this.options.runStore.isCancellationRequested(runId)
      });

      await this.options.runStore.updateRun(runId, {
        status: outcome.status,
        cancelledAt: outcome.status === "cancelled" ? new Date().toISOString() : undefined,
        assistantText: outcome.assistantText,
        artifactPaths: outcome.artifactPaths,
        approvalToken: outcome.approvalToken
      });

      return outcome;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown error";
      await this.options.runStore.appendEvent({
        runId,
        sessionId,
        phase: "final",
        eventType: "failed",
        payload: { error: messageText },
        timestamp: new Date().toISOString()
      });

      await this.options.runStore.updateRun(runId, {
        status: "failed",
        assistantText: `Run failed: ${messageText}`
      });

      return {
        status: "failed",
        assistantText: `Run failed: ${messageText}`
      };
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async handleTurn(input: ChatTurnInput): Promise<{
    runId: string;
    status: RunStatus;
    assistantText?: string;
    artifactPaths?: string[];
    approvalToken?: string;
  }> {
    const session = await this.options.sessionStore.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session ${input.sessionId} does not exist`);
    }

    await this.options.sessionStore.touchSession(input.sessionId);
    const run = await this.options.runStore.createRun(input.sessionId, input.message, input.requestJob ? "queued" : "running");

    await this.options.runStore.appendEvent({
      runId: run.runId,
      sessionId: input.sessionId,
      phase: "route",
      eventType: input.requestJob ? "queued" : "inline",
      payload: { requestJob: Boolean(input.requestJob) },
      timestamp: new Date().toISOString()
    });

    if (input.requestJob) {
      this.options.queue.enqueue(async () => {
        await this.executeRun(run.runId, input.sessionId, input.message);
      });

      return {
        runId: run.runId,
        status: "queued"
      };
    }

    const outcome = await this.executeRun(run.runId, input.sessionId, input.message);

    return {
      runId: run.runId,
      status: outcome.status,
      assistantText: outcome.assistantText,
      artifactPaths: outcome.artifactPaths,
      approvalToken: outcome.approvalToken
    };
  }

  async requestRunCancellation(runId: string): Promise<{
    runId: string;
    accepted: boolean;
    status: RunStatus;
    message: string;
  }> {
    const run = await this.options.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    if (run.status !== "queued" && run.status !== "running") {
      return {
        runId,
        accepted: false,
        status: run.status,
        message: `Run is already ${run.status}.`
      };
    }

    await this.options.runStore.requestCancellation(runId);
    await this.options.runStore.appendEvent({
      runId,
      sessionId: run.sessionId,
      phase: "observe",
      eventType: "cancel_requested",
      payload: {
        runStatus: run.status
      },
      timestamp: new Date().toISOString()
    });

    return {
      runId,
      accepted: true,
      status: run.status,
      message: "Cancellation requested. Alfred will stop and persist partial results."
    };
  }
}
