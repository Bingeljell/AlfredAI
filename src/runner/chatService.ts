import type {
  RunOutcome,
  RunStatus,
  SessionOutputRecord,
  SessionPromptContext,
  SessionRecord,
  SessionTurnSnippet,
  SessionWorkingMemory
} from "../types.js";
import { runReActLoop } from "../runtime/runReActLoop.js";
import { TurnRuntime } from "../runtime/turnRuntime.js";
import { ThreadRuntimeManager } from "../runtime/threadRuntime.js";
import { deriveSessionOutputRecordFromRun } from "../memory/sessionOutputs.js";
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
  pinchtabBaseUrl?: string;
  agentMaxDurationMs: number;
  agentMaxToolCalls: number;
  agentMaxParallelTools: number;
  runLoopRunner?: typeof runReActLoop;
}

export class ChatService {
  private readonly threadRuntimeManager: ThreadRuntimeManager;
  private readonly subscribedThreadSessions = new Set<string>();

  constructor(private readonly options: ChatServiceOptions) {
    this.threadRuntimeManager = new ThreadRuntimeManager({
      queue: this.options.queue,
      createTurnRuntime: (_sessionId) =>
        new TurnRuntime({
          runStore: this.options.runStore,
          executeUserInput: async (payload) =>
            this.executeRunCore(payload.runId, payload.sessionId, payload.message, payload.sessionContext),
          requestCancellation: async (targetRunId) => {
            await this.options.runStore.requestCancellation(targetRunId);
          }
        })
    });
  }

  private ensureThreadSubscription(sessionId: string): void {
    if (this.subscribedThreadSessions.has(sessionId)) {
      return;
    }
    this.subscribedThreadSessions.add(sessionId);
    this.threadRuntimeManager.subscribe(sessionId, (event) => {
      void this.options.runStore.appendEvent({
        runId: event.runId,
        sessionId: event.sessionId,
        phase: "session",
        eventType: `thread_${event.type}`,
        payload: {
          opType: event.opType,
          queuedDepth: event.queuedDepth,
          detail: event.detail
        },
        timestamp: event.timestamp
      });
    });
  }

  private appendRecentTurn(
    turns: SessionTurnSnippet[] | undefined,
    turn: Omit<SessionTurnSnippet, "timestamp"> & { timestamp?: string }
  ): SessionTurnSnippet[] {
    const nextTurn: SessionTurnSnippet = {
      ...turn,
      timestamp: turn.timestamp ?? new Date().toISOString(),
      content: turn.content.replace(/\s+/g, " ").trim().slice(0, 600)
    };
    return [...(turns ?? []), nextTurn].slice(-8);
  }

  private appendRecentOutput(
    outputs: SessionOutputRecord[] | undefined,
    output: SessionOutputRecord | null
  ): SessionOutputRecord[] | undefined {
    if (!output) {
      return outputs;
    }
    const deduped = [...(outputs ?? []).filter((item) => item.id !== output.id), output];
    return deduped.slice(-6);
  }

  private clipText(value: string | undefined, maxLength: number): string {
    if (!value) {
      return "";
    }
    return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  private buildOutcomeSummary(message: string, outcome: RunOutcome): string {
    const assistantSummary = outcome.assistantText?.replace(/\s+/g, " ").trim().slice(0, 280);
    const parts = [`Request: ${message.trim().slice(0, 180)}`, `Status: ${outcome.status}`];
    if (assistantSummary) {
      parts.push(`Outcome: ${assistantSummary}`);
    }
    if (outcome.artifactPaths?.length) {
      parts.push(`Artifacts: ${outcome.artifactPaths.slice(0, 3).join(", ")}`);
    }
    return parts.join(" | ");
  }

  private buildSessionSummary(memory: SessionWorkingMemory): string {
    const parts: string[] = [];
    if (memory.activeObjective) {
      parts.push(`Active objective: ${memory.activeObjective}`);
    }
    if (memory.lastOutcomeSummary) {
      parts.push(`Latest outcome: ${memory.lastOutcomeSummary}`);
    }
    if (memory.lastArtifacts?.length) {
      parts.push(`Artifacts: ${memory.lastArtifacts.join(", ")}`);
    }
    if (memory.recentOutputs?.length) {
      const latest = memory.recentOutputs.at(-1);
      if (latest) {
        parts.push(`Latest output: ${latest.kind} (${latest.availability}) - ${latest.title}`);
      }
    }
    return parts.join(" | ").slice(0, 700);
  }

  private async buildSessionContext(session: SessionRecord): Promise<SessionPromptContext | undefined> {
    const memory = session.workingMemory;
    if (!memory) {
      return undefined;
    }

    let lastCompletedRun: SessionPromptContext["lastCompletedRun"];
    if (memory.lastCompletedRunId) {
      const run = await this.options.runStore.getRun(memory.lastCompletedRunId);
      if (run) {
        lastCompletedRun = {
          runId: run.runId,
          message: run.message.slice(0, 240),
          assistantText: run.assistantText?.slice(0, 320),
          artifactPaths: run.artifactPaths?.slice(0, 5),
          completedAt: memory.lastCompletedAt ?? run.updatedAt
        };
      }
    }

    const context: SessionPromptContext = {
      activeObjective: memory.activeObjective,
      lastRunId: memory.lastRunId,
      lastSpecialist: memory.lastSpecialist,
      lastCompletedRun,
      lastArtifacts: memory.lastArtifacts?.slice(0, 5),
      lastOutcomeSummary: memory.lastOutcomeSummary,
      activeThreadSummary: memory.activeThreadSummary,
      sessionSummary: memory.sessionSummary,
      recentTurns: memory.recentTurns?.slice(-6),
      recentOutputs: memory.recentOutputs?.slice(-4),
      unresolvedItems: memory.unresolvedItems?.slice(-6)
    };

    return Object.values(context).some((value) => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      if (value && typeof value === "object") {
        return Object.keys(value).length > 0;
      }
      return Boolean(value);
    })
      ? context
      : undefined;
  }

  private async persistQueuedRunStart(sessionId: string, runId: string, message: string): Promise<void> {
    const activeObjective = message.trim().slice(0, 240);
    const existingMemory = (await this.options.sessionStore.getSession(sessionId))?.workingMemory;
    await this.options.sessionStore.updateWorkingMemory(sessionId, {
      activeObjective,
      lastRunId: runId,
      recentTurns: this.appendRecentTurn(existingMemory?.recentTurns, {
        role: "user",
        content: message,
        runId
      }),
      activeThreadSummary: this.clipText(message, 320),
      sessionSummary: this.buildSessionSummary({
        ...(existingMemory ?? {}),
        activeObjective,
        lastRunId: runId,
        activeThreadSummary: this.clipText(message, 320)
      })
    });
  }

  private async persistRunOutcome(sessionId: string, runId: string, message: string, outcome: RunOutcome): Promise<void> {
    const lastOutcomeSummary = this.buildOutcomeSummary(message, outcome);
    const existingMemory = (await this.options.sessionStore.getSession(sessionId))?.workingMemory;
    const persistedRun = await this.options.runStore.getRun(runId);
    const recentOutput = deriveSessionOutputRecordFromRun({
      runId,
      message,
      runStatus: outcome.status,
      runCreatedAt: persistedRun?.createdAt,
      assistantText: outcome.assistantText ?? persistedRun?.assistantText,
      artifactPaths: outcome.artifactPaths ?? persistedRun?.artifactPaths,
      toolCalls: persistedRun?.toolCalls
    });
    const memoryPatch: Partial<SessionWorkingMemory> = {
      activeObjective: message.trim().slice(0, 240),
      lastRunId: runId,
      lastOutcomeSummary,
      lastArtifacts: outcome.artifactPaths?.slice(0, 5) ?? [],
      activeThreadSummary: this.clipText(outcome.assistantText ?? message, 320),
      recentOutputs: this.appendRecentOutput(existingMemory?.recentOutputs, recentOutput)
    };

    if (outcome.status === "completed") {
      memoryPatch.lastCompletedRunId = runId;
      memoryPatch.lastCompletedAt = new Date().toISOString();
    }
    if (outcome.specialist) {
      memoryPatch.lastSpecialist = outcome.specialist;
    }

    memoryPatch.recentTurns = this.appendRecentTurn(existingMemory?.recentTurns, {
      role: "assistant",
      content: outcome.assistantText ?? "",
      runId
    });

    const mergedForSummary: SessionWorkingMemory = {
      ...(existingMemory ?? {}),
      ...memoryPatch
    };
    memoryPatch.sessionSummary = this.buildSessionSummary(mergedForSummary);
    await this.options.sessionStore.updateWorkingMemory(sessionId, memoryPatch);
  }

  private async handleNewSessionCommand(sessionId: string): Promise<{
    runId: string;
    status: RunStatus;
    assistantText?: string;
  }> {
    await this.options.sessionStore.resetWorkingMemory(sessionId);
    const run = await this.options.runStore.createRun(sessionId, "/newsession", "completed");
    const assistantText = "Started a fresh session context. Prior run history is still stored, but Alfred will treat the next turn as a new conversation.";
    await this.options.runStore.appendEvent({
      runId: run.runId,
      sessionId,
      phase: "route",
      eventType: "session_reset",
      payload: {},
      timestamp: new Date().toISOString()
    });
    await this.options.runStore.updateRun(run.runId, {
      status: "completed",
      assistantText
    });
    return {
      runId: run.runId,
      status: "completed",
      assistantText
    };
  }

  private async executeRun(
    runId: string,
    sessionId: string,
    message: string,
    sessionContext?: SessionPromptContext
  ): Promise<RunOutcome> {
    this.ensureThreadSubscription(sessionId);
    const dispatch = await this.threadRuntimeManager.submit(sessionId, {
      type: "UserInput",
      payload: {
        runId,
        sessionId,
        message,
        sessionContext
      }
    });
    if (dispatch.outcome) {
      return dispatch.outcome;
    }
    return {
      status: "failed",
      assistantText: `Turn dispatch failed: ${dispatch.reason ?? "unknown"}`
    };
  }

  private async executeRunCore(
    runId: string,
    sessionId: string,
    message: string,
    sessionContext?: SessionPromptContext
  ): Promise<RunOutcome> {
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
    }, 30_000);
    heartbeatTimer.unref?.();

    try {
      const outcome = await (this.options.runLoopRunner ?? runReActLoop)(sessionId, message, runId, {
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
        pinchtabBaseUrl: this.options.pinchtabBaseUrl,
        agentMaxDurationMs: this.options.agentMaxDurationMs,
        agentMaxToolCalls: this.options.agentMaxToolCalls,
        agentMaxParallelTools: this.options.agentMaxParallelTools,
        sessionContext,
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

    if (input.message.trim() === "/newsession") {
      return this.handleNewSessionCommand(input.sessionId);
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
      await this.persistQueuedRunStart(input.sessionId, run.runId, input.message);
      const queuedSessionContext = await this.buildSessionContext((await this.options.sessionStore.getSession(input.sessionId)) ?? session);
      void this.executeRun(run.runId, input.sessionId, input.message, queuedSessionContext).then(async (outcome) => {
        await this.persistRunOutcome(input.sessionId, run.runId, input.message, outcome);
      }).catch(async (error) => {
        const failureOutcome: RunOutcome = {
          status: "failed",
          assistantText: error instanceof Error ? error.message : "Queued run failed"
        };
        await this.options.runStore.updateRun(run.runId, {
          status: "failed",
          assistantText: failureOutcome.assistantText
        });
        await this.persistRunOutcome(input.sessionId, run.runId, input.message, failureOutcome);
      });

      return {
        runId: run.runId,
        status: "queued"
      };
    }

    await this.persistQueuedRunStart(input.sessionId, run.runId, input.message);
    const sessionContext = await this.buildSessionContext((await this.options.sessionStore.getSession(input.sessionId)) ?? session);
    const outcome = await this.executeRun(run.runId, input.sessionId, input.message, sessionContext);
    await this.persistRunOutcome(input.sessionId, run.runId, input.message, outcome);

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
