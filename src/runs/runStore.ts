import { randomUUID } from "node:crypto";
import type { LlmUsage, RunEvent, RunRecord, RunStatus, ToolCallRecord } from "../types.js";
import { redactValue } from "../utils/redact.js";
import { RunEventChannel } from "./eventChannel.js";
import { JsonFileRunStorage } from "./storage/jsonFileRunStorage.js";
import type { RunStorage } from "./storage/types.js";

const LIFECYCLE_EVENT_TYPES = new Set(["TurnStarted", "TurnProgress", "TurnComplete", "TurnAborted"]);

export interface RunLifecycleReplay {
  runId: string;
  sessionId: string;
  startedAt?: string;
  terminalAt?: string;
  terminalEventType?: "TurnComplete" | "TurnAborted";
  progressCount: number;
  lifecycleEvents: RunEvent[];
}

export class RunStore {
  private readonly eventChannel: RunEventChannel;
  private readonly storage: RunStorage;

  constructor(private readonly workspaceDir: string, storage?: RunStorage) {
    this.storage = storage ?? new JsonFileRunStorage(workspaceDir);
    this.eventChannel = new RunEventChannel((event) => this.appendEventDirect(event));
  }

  private mergeLlmUsage(
    current: RunRecord["llmUsage"],
    usage: LlmUsage,
    callCountDelta: number
  ): NonNullable<RunRecord["llmUsage"]> {
    return {
      promptTokens: Math.max(0, (current?.promptTokens ?? 0) + Math.max(0, Math.round(usage.promptTokens))),
      completionTokens: Math.max(0, (current?.completionTokens ?? 0) + Math.max(0, Math.round(usage.completionTokens))),
      totalTokens: Math.max(0, (current?.totalTokens ?? 0) + Math.max(0, Math.round(usage.totalTokens))),
      callCount: Math.max(0, (current?.callCount ?? 0) + Math.max(0, Math.round(callCountDelta)))
    };
  }

  async createRun(sessionId: string, message: string, status: RunStatus): Promise<RunRecord> {
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: randomUUID(),
      sessionId,
      message,
      status,
      createdAt: now,
      updatedAt: now,
      llmUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        callCount: 0
      },
      toolCalls: []
    };
    await this.storage.writeRun(run.runId, run);
    return run;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.storage.readRun(runId);
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const current = await this.getRun(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }
    const updated: RunRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    await this.storage.writeRun(runId, updated);
    return updated;
  }

  async requestCancellation(runId: string): Promise<RunRecord> {
    const now = new Date().toISOString();
    const run = await this.updateRun(runId, {
      cancelRequestedAt: now
    });
    return run;
  }

  async clearCancellation(runId: string): Promise<RunRecord> {
    const run = await this.updateRun(runId, {
      cancelRequestedAt: undefined
    });
    return run;
  }

  async isCancellationRequested(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    return Boolean(run?.cancelRequestedAt);
  }

  async addToolCall(runId: string, call: ToolCallRecord): Promise<void> {
    const current = await this.getRun(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }
    const updated: RunRecord = {
      ...current,
      toolCalls: [...current.toolCalls, call],
      updatedAt: new Date().toISOString()
    };
    await this.storage.writeRun(runId, updated);
  }

  async addLlmUsage(runId: string, usage: LlmUsage, callCountDelta = 1): Promise<void> {
    const current = await this.getRun(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }
    const updated: RunRecord = {
      ...current,
      llmUsage: this.mergeLlmUsage(current.llmUsage, usage, callCountDelta),
      updatedAt: new Date().toISOString()
    };
    await this.storage.writeRun(runId, updated);
  }

  private async appendEventDirect(event: RunEvent): Promise<void> {
    await this.storage.appendEvent(event);
  }

  async appendEvent(event: RunEvent): Promise<void> {
    await this.eventChannel.push(event);
  }

  async flushEvents(): Promise<void> {
    await this.eventChannel.flush();
  }

  async listRuns(sessionId: string, limit = 20): Promise<RunRecord[]> {
    const runs: RunRecord[] = [];
    const runIds = await this.storage.listRunIds();
    for (const runId of runIds) {
      const run = await this.storage.readRun(runId);
      if (run && run.sessionId === sessionId) {
        runs.push(run);
      }
    }
    runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return runs.slice(0, Math.max(1, limit));
  }

  async listRunEvents(run: RunRecord): Promise<RunEvent[]> {
    await this.flushEvents();
    const day = run.createdAt.slice(0, 10);
    const events = await this.storage.readSessionDayEvents(run.sessionId, day);
    return events.filter((event) => event.runId === run.runId);
  }

  async replayLifecycle(runId: string): Promise<RunLifecycleReplay> {
    const run = await this.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const events = await this.listRunEvents(run);
    const lifecycleEvents = events.filter((event) => LIFECYCLE_EVENT_TYPES.has(event.eventType));
    const startedEvent = lifecycleEvents.find((event) => event.eventType === "TurnStarted");
    const terminalEvent = [...lifecycleEvents]
      .reverse()
      .find((event) => event.eventType === "TurnComplete" || event.eventType === "TurnAborted");
    const progressCount = lifecycleEvents.filter((event) => event.eventType === "TurnProgress").length;

    return {
      runId,
      sessionId: run.sessionId,
      startedAt: startedEvent?.timestamp,
      terminalAt: terminalEvent?.timestamp,
      terminalEventType:
        terminalEvent?.eventType === "TurnComplete" || terminalEvent?.eventType === "TurnAborted"
          ? terminalEvent.eventType
          : undefined,
      progressCount,
      lifecycleEvents
    };
  }

  async buildDebugExport(runId: string): Promise<Record<string, unknown>> {
    const run = await this.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const events = await this.listRunEvents(run);
    return redactValue({
      generatedAt: new Date().toISOString(),
      run,
      events
    }) as Record<string, unknown>;
  }
}
