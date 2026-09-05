import type {
  ConversationWindowEntry,
  RunOutcome,
  RunStatus,
  RunRecord,
  SessionOutputRecord,
  SessionPromptContext,
  EffectiveModelSelection,
  SessionRecord,
  SessionTurnSnippet,
  SessionWorkingMemory
} from "../types.js";
import { redactValue } from "../utils/redact.js";
import { conversationWindow } from "../memory/conversationHistory.js";
import type { GroupChatStore } from "../memory/groupChatStore.js";
import type { runReActLoop } from "../runtime/runReActLoop.js";
import { AlfredAgentRuntime, type AgentRuntime } from "../runtime/agentRuntime.js";
import { TurnRuntime } from "../runtime/turnRuntime.js";
import { ThreadRuntimeManager } from "../runtime/threadRuntime.js";
import { deriveSessionOutputRecordFromRun } from "../memory/sessionOutputs.js";
import type { SessionStore } from "../memory/sessionStore.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { InMemoryQueue } from "../workers/inMemoryQueue.js";
import type { SchedulerTaskApi } from "../scheduler/api.js";
import type { SchedulerProvenance, SchedulerOrigin } from "../scheduler/notifier.js";
import type { SchedulerTurnControl } from "../scheduler/api.js";
import type { WatchSnapshot } from "../scheduler/probes/types.js";
import type { TaskTranscriptEntry, TaskTranscriptStore } from "../scheduler/taskTranscript.js";
import { createSchedulerTurnControl } from "../scheduler/execution.js";
import { SCHEDULER_EXECUTION_PROFILE, type TurnExecutionProfile } from "../runtime/executionProfile.js";
import type { CodexModel } from "../provider/codex/subscriptionService.js";
import {
  findEffortMatches,
  findModelMatches,
  formatModelCommand,
  formatReasoningCommand,
  formatUsageCommand,
  parseControlCommand,
  resolveModelSelection,
  reachedRateLimit,
  type SubscriptionChatService
} from "./chatControls.js";

interface ChatTurnInput {
  sessionId: string;
  message: string;
  requestJob?: boolean;
  channelKey?: string;
  principalId?: string;
  origin?: SchedulerOrigin;
  requestId?: string;
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
  agentRuntime?: AgentRuntime;
  groupChatStore?: GroupChatStore;
  scheduler?: SchedulerTaskApi;
  sessionMutex?: SessionMutex;
  taskTranscriptStore?: TaskTranscriptStore;
  subscriptionService?: SubscriptionChatService;
  globalModel?: string;
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
  private readonly admissionMutex = new SessionMutex();
  private readonly threadRuntimeManager: ThreadRuntimeManager;
  private readonly subscribedThreadSessions = new Set<string>();
  private readonly scheduledTurnPromises = new Map<string, Promise<RunOutcome>>();
  private readonly sessionMutex: SessionMutex;
  private readonly agentRuntime: AgentRuntime;

  constructor(private readonly options: ChatServiceOptions) {
    this.sessionMutex = this.options.sessionMutex ?? new SessionMutex();
    this.agentRuntime = this.options.agentRuntime ?? new AlfredAgentRuntime({
      runStore: this.options.runStore,
      searchManager: this.options.searchManager,
      workspaceDir: this.options.workspaceDir,
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
      runLoopRunner: this.options.runLoopRunner,
      scheduler: this.options.scheduler
    });
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

  private async buildSessionContext(session: SessionRecord, modelSelection?: EffectiveModelSelection): Promise<SessionPromptContext | undefined> {
    const memory = session.workingMemory;
    const history = await this.options.runStore.listHistory(session.id, { limit: 100 });
    const canonicalWindow = conversationWindow(history.runs);
    if (!memory && !modelSelection && !canonicalWindow.length) {
      return undefined;
    }

    let lastCompletedRun: SessionPromptContext["lastCompletedRun"];
    if (memory?.lastCompletedRunId) {
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
      activeObjective: memory?.activeObjective,
      lastRunId: memory?.lastRunId,
      lastSpecialist: memory?.lastSpecialist,
      lastCompletedRun,
      lastArtifacts: memory?.lastArtifacts?.slice(0, 5),
      lastOutcomeSummary: memory?.lastOutcomeSummary,
      activeThreadSummary: memory?.activeThreadSummary,
      sessionSummary: memory?.sessionSummary,
      recentTurns: memory?.recentTurns?.slice(-6),
      recentOutputs: memory?.recentOutputs?.slice(-4),
      unresolvedItems: memory?.unresolvedItems?.slice(-6),
      conversationWindow: canonicalWindow.length ? canonicalWindow : memory?.conversationWindow,
      modelSelection
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

  private async handleNewSessionCommand(sessionId: string): Promise<RunOutcome & { runId: string; sessionId: string }> {
    const previous = await this.options.sessionStore.getSession(sessionId);
    const session = await this.options.sessionStore.createSession(previous?.name);
    return {
      runId: "", sessionId: session.id, status: "completed",
      assistantText: "Started a new conversation. The previous conversation and its context remain available on every surface."
    };
  }

  private async liveModels(): Promise<CodexModel[]> {
    if (!this.options.subscriptionService) throw new Error("Live ChatGPT model controls are unavailable for the configured provider.");
    const models = await this.options.subscriptionService.listModels();
    return models.filter((model) => !model.hidden);
  }

  private async resolveLiveSelection(session: SessionRecord): Promise<{ selection: EffectiveModelSelection; model: CodexModel }> {
    const models = await this.liveModels();
    const resolution = resolveModelSelection(models, {
      preferences: session.preferences,
      globalModel: this.options.globalModel ?? ""
    });
    if (JSON.stringify(resolution.nextPreferences ?? {}) !== JSON.stringify(session.preferences ?? {})) {
      await this.options.sessionStore.setPreferences(session.id, resolution.nextPreferences);
    }
    return { selection: resolution.selection, model: resolution.model };
  }

  private localSessionTokens(sessionId: string): Promise<number> {
    return this.options.runStore.sumSessionTokens(sessionId);
  }

  private async controlResponse(session: SessionRecord, message: string): Promise<string | undefined> {
    const parsed = parseControlCommand(message);
    if (!parsed) return undefined;

    if (parsed.command === "/help") {
      return [
        "Alfred commands:",
        "/help — show this message",
        "/status — show this session and effective model settings",
        "/model — list live picker-visible models",
        "/model N|NAME — select a model for this session",
        "/model default — clear the session model override",
        "/reasoning — list efforts supported by the effective model",
        "/reasoning N|NAME — select reasoning for this session",
        "/reasoning default — use the model default effort",
        "/usage — show subscription quota separately from Alfred local tokens",
        "/newsession — start a fresh session context"
      ].join("\n");
    }

    if (parsed.command === "/status") {
      const tokens = await this.localSessionTokens(session.id);
      if (!this.options.subscriptionService) {
        return [`Session: ${session.id}`, `Local Alfred tokens: ${tokens}`, "Model controls: unavailable for the configured provider."].join("\n");
      }
      const resolved = await this.resolveLiveSelection(session);
      return [
        `Session: ${session.id}`,
        `Model: ${resolved.model.displayName} (${resolved.model.id})${session.preferences?.modelId ? " [session override]" : " [global/default]"}`,
        `Reasoning: ${resolved.selection.reasoningEffort ?? "model default"}${session.preferences?.reasoningEffort ? " [session override]" : " [model default]"}`,
        `Local Alfred tokens: ${tokens}`
      ].join("\n");
    }

    if (parsed.command === "/usage") {
      if (!this.options.subscriptionService) {
        return `Subscription usage is unavailable for the configured provider. Alfred local session token usage: ${await this.localSessionTokens(session.id)} tokens.`;
      }
      const [usage, tokens] = await Promise.all([
        this.options.subscriptionService.readUsage(true),
        this.localSessionTokens(session.id)
      ]);
      return formatUsageCommand(usage, tokens);
    }

    if (parsed.command !== "/model" && parsed.command !== "/reasoning") return undefined;
    if (!this.options.subscriptionService) return "Live ChatGPT model and reasoning controls are unavailable for the configured provider.";

    const models = await this.liveModels();
    const context = { preferences: session.preferences, globalModel: this.options.globalModel ?? "" };
    if (parsed.command === "/model") {
      if (parsed.args.length === 0 || parsed.args[0]?.toLowerCase() === "page" || parsed.args[0]?.toLowerCase() === "more") {
        return formatModelCommand(models, context, parsed.args);
      }
      if (parsed.args.length === 1 && parsed.args[0]?.toLowerCase() === "default") {
        const resolution = resolveModelSelection(models, { preferences: { ...session.preferences, modelId: undefined }, globalModel: context.globalModel });
        await this.options.sessionStore.setPreferences(session.id, resolution.nextPreferences);
        return `Model reset to ${resolution.model.displayName} (${resolution.model.id}) using the global/default catalog selection.${resolution.selection.notice ? ` ${resolution.selection.notice}` : ""}`;
      }
      const numeric = parsed.args.length === 1 ? Number(parsed.args[0]) : NaN;
      const matches = Number.isInteger(numeric) && numeric > 0
        ? (models[numeric - 1] ? [models[numeric - 1]] : [])
        : findModelMatches(models, parsed.args.join(" "));
      if (matches.length === 0) return "No live picker-visible model matched that selection. Use /model to see the numbered list.";
      if (matches.length > 1) return ["That model alias is ambiguous; choose one:", ...matches.map((model) => `- ${model.displayName} (${model.id})`)].join("\n");
      const resolution = resolveModelSelection(models, { preferences: { ...session.preferences, modelId: matches[0]!.id }, globalModel: context.globalModel });
      await this.options.sessionStore.setPreferences(session.id, resolution.nextPreferences);
      return `Model set to ${resolution.model.displayName} (${resolution.model.id}) for this session.${resolution.selection.notice ? ` ${resolution.selection.notice}` : ""}`;
    }

    const resolved = resolveModelSelection(models, context);
    if (parsed.args.length === 0) return formatReasoningCommand(resolved.model, session.preferences);
    if (parsed.args.length === 1 && parsed.args[0]?.toLowerCase() === "default") {
      await this.options.sessionStore.setPreferences(session.id, { ...resolved.nextPreferences, reasoningEffort: undefined });
      return `Reasoning reset to ${resolved.model.defaultReasoningEffort || "the model default"} for ${resolved.model.displayName}.`;
    }
    const numeric = parsed.args.length === 1 ? Number(parsed.args[0]) : NaN;
    const effort = Number.isInteger(numeric) && numeric > 0
      ? resolved.model.supportedReasoningEfforts[numeric - 1]
      : findEffortMatches(resolved.model, parsed.args.join(" "))[0];
    if (!effort) return `That reasoning effort is not supported by ${resolved.model.displayName}. Use /reasoning to see the live list.`;
    await this.options.sessionStore.setPreferences(session.id, { ...resolved.nextPreferences, reasoningEffort: effort.reasoningEffort });
    return `Reasoning set to ${effort.reasoningEffort} for ${resolved.model.displayName} for this session.`;
  }

  private async prepareCodexTurn(session: SessionRecord): Promise<{ selection?: EffectiveModelSelection; blocked?: string }> {
    if (!this.options.subscriptionService) return {};
    const resolved = await this.resolveLiveSelection(session);
    const reached = reachedRateLimit(await this.options.subscriptionService.readRateLimits());
    if (reached) {
      const reset = reached.resetAt ? ` Reset: ${new Date(reached.resetAt * 1_000).toISOString()}.` : "";
      return { selection: resolved.selection, blocked: `ChatGPT subscription limit reached for ${reached.bucket} (${reached.reachedType}).${reset} Use /usage for the current quota.` };
    }
    return { selection: resolved.selection };
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
      const rawOutcome = await this.agentRuntime.runTurn({
        runId,
        sessionId,
        message,
        sessionContext,
        modelSelection: sessionContext?.modelSelection,
        provenance,
        executionProfile,
        schedulerControl
      });
      const outcome = sessionContext?.modelSelection?.notice && rawOutcome.assistantText
        ? { ...rawOutcome, assistantText: `${sessionContext.modelSelection.notice}\n\n${rawOutcome.assistantText}` }
        : rawOutcome;

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

  async handleTurn(input: ChatTurnInput): Promise<RunOutcome & { runId: string; sessionId?: string }> {
    if ((!input.requestJob && !input.requestId) || parseControlCommand(input.message)) {
      return this.sessionMutex.run(input.sessionId, () => this.executeTurn(input));
    }
    // Admission is short and separate from execution. Persist before acknowledging.
    return this.admissionMutex.run(input.sessionId, async () => {
      if (!await this.options.sessionStore.getSession(input.sessionId)) throw new Error(`Session ${input.sessionId} does not exist`);
      const ingress = this.provenance(input);
      if (input.requestId) {
        const existing = await this.options.runStore.findRequest(input.sessionId, ingress.principalId, input.requestId);
        if (existing) {
          if (existing.message !== redactValue(input.message)) throw new Error("request_id_conflict");
          return { runId: existing.runId, status: existing.status, assistantText: existing.assistantText };
        }
      }
      const run = await this.options.runStore.createRun(input.sessionId, input.message, "queued", undefined, { ...ingress, requestId: input.requestId });
      // acquire() registers its place synchronously, preserving ingress order.
      void this.sessionMutex.run(input.sessionId, () => this.executeTurn(input, run)).catch((error: unknown) => {
        console.error(`[chat] admitted run ${run.runId} failed to persist:`, error);
      });
      return { runId: run.runId, status: "queued" };
    });
  }

  private provenance(input: ChatTurnInput): SchedulerProvenance {
    return {
      principalId: input.principalId ?? input.sessionId,
      channelKey: input.channelKey,
      origin: input.origin ?? (input.channelKey?.startsWith("telegram:") ? "telegram" : input.channelKey?.startsWith("tui:") ? "tui" : "web")
    };
  }

  /** Called only while holding the execution mutex; context sees completed predecessors. */
  private async executeTurn(input: ChatTurnInput, admitted?: RunRecord): Promise<RunOutcome & { runId: string; sessionId?: string }> {
    let run = admitted;
    const persist = async (outcome: RunOutcome): Promise<RunOutcome & { runId: string; sessionId?: string }> => {
      if (!run) return { ...outcome, runId: "" };
      await this.options.runStore.updateRun(run.runId, {
        status: outcome.status, assistantText: outcome.assistantText, artifactPaths: outcome.artifactPaths,
        approvalToken: outcome.approvalToken
      });
      await this.persistRunOutcome(input.sessionId, run.runId, input.message, outcome);
      if (input.channelKey && this.options.groupChatStore) {
        await this.options.groupChatStore.appendTurn(input.channelKey, run.runId, input.sessionId, input.message, outcome.assistantText ?? "", outcome.artifactPaths ?? []);
      }
      return { ...outcome, runId: run.runId };
    };
    try {
      const session = await this.options.sessionStore.getSession(input.sessionId);
      if (!session) throw new Error(`Session ${input.sessionId} does not exist`);
      if (input.message.trim() === "/newsession") return this.handleNewSessionCommand(input.sessionId);
      const control = await this.controlResponse(session, input.message);
      if (control !== undefined) return { runId: "", status: "completed", assistantText: control };
      const prepared = await this.prepareCodexTurn(session);
      if (prepared.blocked) return persist({ status: "failed", assistantText: prepared.blocked });
      await this.options.sessionStore.touchSession(input.sessionId);
      const provenance = this.provenance(input);
      run ??= await this.options.runStore.createRun(input.sessionId, input.message, "running", undefined, provenance);
      await this.options.runStore.appendEvent({
        runId: run.runId, sessionId: input.sessionId, phase: "route", eventType: admitted ? "queued" : "inline",
        payload: { requestJob: Boolean(admitted) }, timestamp: new Date().toISOString()
      });
      const sessionContext = await this.buildSessionContext(session, prepared.selection);
      await this.persistQueuedRunStart(input.sessionId, run.runId, input.message);
      const outcome = await this.executeRun(run.runId, input.sessionId, input.message, sessionContext, provenance);
      return await persist(outcome);
    } catch (error) {
      if (!run && !parseControlCommand(input.message)) throw error;
      return persist({ status: "failed", assistantText: `Alfred could not complete this turn: ${error instanceof Error ? error.message : "provider unavailable"}` });
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
      const session = await this.options.sessionStore.getSession(input.sessionId);
      const prepared = session ? await this.prepareCodexTurn(session) : {};
      if (prepared.blocked) {
        outcome = { status: "failed", assistantText: prepared.blocked };
      } else {
        outcome = await this.executeRun(
          run.runId,
          input.sessionId,
          message,
          prepared.selection ? { modelSelection: prepared.selection } : undefined,
          { ...input.owner, origin: "scheduler" },
          profile,
          control
        );
      }
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
