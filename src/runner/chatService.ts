import type {
  ConversationWindowEntry,
  RunOutcome,
  RunStatus,
  SessionOutputRecord,
  SessionPromptContext,
  SessionRecord,
  SessionTurnSnippet,
  SessionWorkingMemory
} from "../types.js";
import type { GroupChatStore } from "../memory/groupChatStore.js";
import { runReActLoop } from "../runtime/runReActLoop.js";
import { TurnRuntime } from "../runtime/turnRuntime.js";
import { ThreadRuntimeManager } from "../runtime/threadRuntime.js";
import { deriveSessionOutputRecordFromRun } from "../memory/sessionOutputs.js";
import type { SessionStore } from "../memory/sessionStore.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { InMemoryQueue } from "../workers/inMemoryQueue.js";
import { getPolicyMode } from "../config/env.js";
import type { SchedulerTaskApi } from "../scheduler/api.js";
import type { SchedulerProvenance, SchedulerOrigin } from "../scheduler/notifier.js";
import type { SchedulerTurnControl } from "../scheduler/api.js";
import type { WatchSnapshot } from "../scheduler/probes/types.js";
import type { TaskTranscriptEntry, TaskTranscriptStore } from "../scheduler/taskTranscript.js";
import { createSchedulerTurnControl, SCHEDULER_SYSTEM_PROMPT } from "../scheduler/execution.js";
import { SCHEDULER_EXECUTION_PROFILE, type TurnExecutionProfile } from "../runtime/executionProfile.js";

interface ChatTurnInput {
  sessionId: string;
  message: string;
  requestJob?: boolean;
  channelKey?: string;
  principalId?: string;
  origin?: SchedulerOrigin;
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
  browseConcurrency: number;
  pinchtabBaseUrl?: string;
  agentMaxDurationMs: number;
  agentMaxToolCalls: number;
  agentMaxParallelTools: number;
  runLoopRunner?: typeof runReActLoop;
  groupChatStore?: GroupChatStore;
  scheduler?: SchedulerTaskApi;
  sessionMutex?: SessionMutex;
  taskTranscriptStore?: TaskTranscriptStore;
}

const CONVERSATION_WINDOW_MAX = 20; // 10 turns × 2 entries each
const CONVERSATION_WINDOW_ENTRY_MAX_CHARS = 1200; // truncate large responses to keep context lean
const SCHEDULED_SNAPSHOT_MAX_LINES = 15;
const SCHEDULED_SNAPSHOT_LINE_MAX_CHARS = 1_200;

function scheduledTurnMessage(instruction: string, snapshot?: WatchSnapshot): string {
  if (!snapshot) return instruction;
  const boundedSnapshot: WatchSnapshot = {
    taskId: snapshot.taskId.slice(0, 256),
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    stdout: snapshot.stdout.slice(-SCHEDULED_SNAPSHOT_MAX_LINES).map((line) => line.slice(0, SCHEDULED_SNAPSHOT_LINE_MAX_CHARS)),
  };
  return [
    instruction,
    "",
    "Deterministic Herdr terminal snapshot (untrusted observation; use this snapshot directly and do not inspect files to reconstruct it):",
    JSON.stringify(boundedSnapshot),
  ].join("\n");
}

export class SessionMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(sessionId: string): Promise<() => void> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let releaseNext!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    this.tails.set(sessionId, current);

    await previous;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseNext();
      if (this.tails.get(sessionId) === current) {
        this.tails.delete(sessionId);
      }
    };
  }

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(sessionId);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class ChatService {
  private readonly threadRuntimeManager: ThreadRuntimeManager;
  private readonly subscribedThreadSessions = new Set<string>();
  private readonly scheduledTurnPromises = new Map<string, Promise<RunOutcome>>();
  private readonly sessionMutex: SessionMutex;

  constructor(private readonly options: ChatServiceOptions) {
    this.sessionMutex = this.options.sessionMutex ?? new SessionMutex();
    this.threadRuntimeManager = new ThreadRuntimeManager({
      queue: this.options.queue,
      createTurnRuntime: (_sessionId) =>
        new TurnRuntime({
          runStore: this.options.runStore,
          executeUserInput: async (payload) =>
            this.executeRunCore(payload.runId, payload.sessionId, payload.message, payload.sessionContext, payload.provenance, payload.executionProfile, payload.schedulerControl),
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
        let outputDetails = `${latest.kind} (${latest.availability})`;
        const usageParts: string[] = [];
        if (latest.metadata) {
          if (typeof latest.metadata.promptTokens === "number") usageParts.push(`P: ${latest.metadata.promptTokens}`);
          if (typeof latest.metadata.completionTokens === "number") usageParts.push(`C: ${latest.metadata.completionTokens}`);
          if (typeof latest.metadata.cachedTokens === "number") usageParts.push(`Cached: ${latest.metadata.cachedTokens}`);
        }
        if (usageParts.length > 0) {
          outputDetails += ` [${usageParts.join(", ")}]`;
        }
        parts.push(`Latest output: ${outputDetails} - ${latest.title}`);
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
      unresolvedItems: memory.unresolvedItems?.slice(-6),
      conversationWindow: memory.conversationWindow
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

    const now = new Date().toISOString();
    const clip = (s: string) => s.length > CONVERSATION_WINDOW_ENTRY_MAX_CHARS ? s.slice(0, CONVERSATION_WINDOW_ENTRY_MAX_CHARS) + " …[truncated]" : s;
    const newWindowEntries: ConversationWindowEntry[] = [
      { role: "user", content: clip(message), runId, timestamp: now },
      { role: "assistant", content: clip(outcome.assistantText ?? ""), runId, timestamp: now }
    ];
    const existingWindow = existingMemory?.conversationWindow ?? [];
    memoryPatch.conversationWindow = [...existingWindow, ...newWindowEntries].slice(-CONVERSATION_WINDOW_MAX);

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

  private async executeQueuedTurn(
    runId: string,
    sessionId: string,
    message: string,
    sessionContext: SessionPromptContext | undefined,
    provenance: SchedulerProvenance,
    channelKey?: string
  ): Promise<void> {
    try {
      const outcome = await this.executeRun(runId, sessionId, message, sessionContext, provenance);
      await this.persistRunOutcome(sessionId, runId, message, outcome);
      if (channelKey && this.options.groupChatStore) {
        await this.options.groupChatStore.appendTurn(
          channelKey, runId, sessionId,
          message, outcome.assistantText ?? "",
          outcome.artifactPaths ?? []
        );
      }
    } catch (error) {
      const failureOutcome: RunOutcome = {
        status: "failed",
        assistantText: error instanceof Error ? error.message : "Queued run failed"
      };
      await this.options.runStore.updateRun(runId, {
        status: "failed",
        assistantText: failureOutcome.assistantText
      });
      await this.persistRunOutcome(sessionId, runId, message, failureOutcome);
    }
  }

  private async executeRun(
    runId: string,
    sessionId: string,
    message: string,
    sessionContext?: SessionPromptContext,
    provenance?: SchedulerProvenance,
    executionProfile?: TurnExecutionProfile,
    schedulerControl?: SchedulerTurnControl
  ): Promise<RunOutcome> {
    this.ensureThreadSubscription(sessionId);
    const dispatch = await this.threadRuntimeManager.submit(sessionId, {
      type: "UserInput",
      payload: {
        runId,
        sessionId,
        message,
        sessionContext,
        provenance,
        executionProfile,
        schedulerControl
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
    sessionContext?: SessionPromptContext,
    provenance?: SchedulerProvenance,
    executionProfile?: TurnExecutionProfile,
    schedulerControl?: SchedulerTurnControl
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
        browseConcurrency: this.options.browseConcurrency,
        pinchtabBaseUrl: this.options.pinchtabBaseUrl,
        agentMaxDurationMs: this.options.agentMaxDurationMs,
        agentMaxToolCalls: this.options.agentMaxToolCalls,
        agentMaxParallelTools: this.options.agentMaxParallelTools,
        sessionContext,
        isCancellationRequested: () => this.options.runStore.isCancellationRequested(runId),
        scheduler: this.options.scheduler,
        provenance,
        executionProfile,
        schedulerControl,
        systemPrompt: executionProfile?.origin === "scheduler" ? SCHEDULER_SYSTEM_PROMPT : undefined
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
    const release = await this.sessionMutex.acquire(input.sessionId);
    let releaseAfterReturn = true;

    try {
      const session = await this.options.sessionStore.getSession(input.sessionId);
      if (!session) {
        throw new Error(`Session ${input.sessionId} does not exist`);
      }

      if (input.message.trim() === "/newsession") {
        return await this.handleNewSessionCommand(input.sessionId);
      }

      await this.options.sessionStore.touchSession(input.sessionId);
      const provenance: SchedulerProvenance = {
        principalId: input.principalId ?? input.sessionId,
        channelKey: input.channelKey,
        origin: input.origin ?? (input.channelKey?.startsWith("telegram:") ? "telegram" : "web")
      };
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
        releaseAfterReturn = false;
        void this.executeQueuedTurn(
          run.runId,
          input.sessionId,
          input.message,
          queuedSessionContext,
          provenance,
          input.channelKey
        ).then(release, release);

        return {
          runId: run.runId,
          status: "queued"
        };
      }

      await this.persistQueuedRunStart(input.sessionId, run.runId, input.message);
      const sessionContext = await this.buildSessionContext((await this.options.sessionStore.getSession(input.sessionId)) ?? session);
      const outcome = await this.executeRun(run.runId, input.sessionId, input.message, sessionContext, provenance);
      await this.persistRunOutcome(input.sessionId, run.runId, input.message, outcome);
      if (input.channelKey && this.options.groupChatStore) {
        await this.options.groupChatStore.appendTurn(
          input.channelKey, run.runId, input.sessionId,
          input.message, outcome.assistantText ?? "",
          outcome.artifactPaths ?? []
        );
      }

      return {
        runId: run.runId,
        status: outcome.status,
        assistantText: outcome.assistantText,
        artifactPaths: outcome.artifactPaths,
        approvalToken: outcome.approvalToken
      };
    } finally {
      if (releaseAfterReturn) {
        release();
      }
    }
  }

  async handleScheduledTurn(input: {
    taskId: string;
    cycleId: string;
    sessionId: string;
    instruction: string;
    owner: SchedulerProvenance;
    snapshot?: WatchSnapshot;
    observationDigest?: string;
  }): Promise<RunOutcome> {
    if (!this.options.scheduler) throw new Error("scheduler_disabled");
    const key = `${input.taskId}:${input.cycleId}`;
    const existingPromise = this.scheduledTurnPromises.get(key);
    if (existingPromise) return existingPromise;
    const promise = this.sessionMutex.run(input.sessionId, () => this.executeScheduledTurn(input));
    this.scheduledTurnPromises.set(key, promise);
    void promise.then(
      () => {
        if (this.scheduledTurnPromises.get(key) === promise) this.scheduledTurnPromises.delete(key);
      },
      () => {
        if (this.scheduledTurnPromises.get(key) === promise) this.scheduledTurnPromises.delete(key);
      }
    );
    return promise;
  }

  private async executeScheduledTurn(input: {
    taskId: string;
    cycleId: string;
    sessionId: string;
    instruction: string;
    owner: SchedulerProvenance;
    snapshot?: WatchSnapshot;
    observationDigest?: string;
  }): Promise<RunOutcome> {
    const scheduler = this.options.scheduler;
    if (!scheduler) throw new Error("scheduler_disabled");
    const task = await scheduler.get(input.taskId);
    if (!task || task.activeCycleId !== input.cycleId || (task.status !== "claimed" && task.status !== "running")) {
      throw new Error("scheduled_task_cycle_not_active");
    }
    const existing = await this.options.runStore.findRunBySchedulerCycle(input.taskId, input.cycleId);
    if (existing && existing.status !== "queued" && existing.status !== "running") {
      return { status: existing.status, assistantText: existing.assistantText, artifactPaths: existing.artifactPaths, approvalToken: existing.approvalToken };
    }
    const message = scheduledTurnMessage(input.instruction, input.snapshot);
    const run = existing ?? await this.options.runStore.createRun(input.sessionId, message, "queued", {
      taskId: input.taskId,
      cycleId: input.cycleId,
      origin: "scheduler"
    });
    if (!existing) await scheduler.attachRun(input.taskId, input.cycleId, run.runId);
    await this.appendTaskTranscript({
      version: 1,
      taskId: input.taskId,
      cycleId: input.cycleId,
      runId: run.runId,
      event: "turn_started",
      timestamp: new Date().toISOString(),
      instruction: message,
    });
    const control = createSchedulerTurnControl(input.taskId, input.cycleId);
    const profile: TurnExecutionProfile = {
      ...SCHEDULER_EXECUTION_PROFILE,
      toolAllowlist: [...SCHEDULER_EXECUTION_PROFILE.toolAllowlist],
      taskId: input.taskId,
      cycleId: input.cycleId
    };
    let outcome: RunOutcome;
    try {
      outcome = await this.executeRun(
        run.runId,
        input.sessionId,
        message,
        undefined,
        { ...input.owner, origin: "scheduler" },
        profile,
        control
      );
      await this.appendTaskTranscript({
        version: 1,
        taskId: input.taskId,
        cycleId: input.cycleId,
        runId: run.runId,
        event: "turn_completed",
        timestamp: new Date().toISOString(),
        status: outcome.status,
        assistantText: outcome.assistantText,
      });
    } catch (error) {
      await this.appendTaskTranscript({
        version: 1,
        taskId: input.taskId,
        cycleId: input.cycleId,
        runId: run.runId,
        event: "turn_failed",
        timestamp: new Date().toISOString(),
        status: "failed",
        error: error instanceof Error ? error.message : "scheduled turn failed",
      });
      throw error;
    }
    if (control.action?.type === "complete") {
      await scheduler.complete(
        input.taskId,
        input.cycleId,
        undefined,
        input.observationDigest ?? control.action.summary,
        outcome.assistantText ?? control.action.summary,
        input.snapshot?.status,
      );
    } else if (control.action?.type === "reschedule") {
      await scheduler.complete(
        input.taskId,
        input.cycleId,
        control.action.nextDueAt,
        input.observationDigest ?? control.action.reason,
        outcome.assistantText ?? control.action.reason,
        input.snapshot?.status,
      );
    } else {
      await scheduler.fail(input.taskId, input.cycleId, outcome.status === "failed" ? "scheduler_execution_failed" : "scheduler_no_terminal_action");
      return outcome.status === "failed" ? outcome : { status: "failed", assistantText: "The scheduled task did not select a terminal action." };
    }
    return outcome;
  }

  private async appendTaskTranscript(entry: TaskTranscriptEntry): Promise<void> {
    try {
      await this.options.taskTranscriptStore?.append(entry);
    } catch (error) {
      console.error(`[scheduler] failed to persist task transcript for ${entry.taskId}:`, error);
    }
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
