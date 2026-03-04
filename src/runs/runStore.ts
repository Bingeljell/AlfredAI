import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { LlmUsage, RunEvent, RunRecord, RunStatus, ToolCallRecord } from "../types.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../utils/fs.js";
import { redactValue } from "../utils/redact.js";

export class RunStore {
  constructor(private readonly workspaceDir: string) {}

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

  private get stateDir(): string {
    return path.join(this.workspaceDir, "runs/state");
  }

  private runStatePath(runId: string): string {
    return path.join(this.stateDir, `${runId}.json`);
  }

  private async appendJsonLine(filePath: string, value: unknown): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
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
    await writeJsonFile(this.runStatePath(run.runId), run);
    return run;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return readJsonFile<RunRecord | undefined>(this.runStatePath(runId), undefined);
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
    await writeJsonFile(this.runStatePath(runId), updated);
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
    await writeJsonFile(this.runStatePath(runId), updated);
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
    await writeJsonFile(this.runStatePath(runId), updated);
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const day = event.timestamp.slice(0, 10);
    const filePath = path.join(this.workspaceDir, "runs", event.sessionId, `${day}.jsonl`);
    await this.appendJsonLine(filePath, event);
  }

  async listRuns(sessionId: string, limit = 20): Promise<RunRecord[]> {
    await ensureDir(this.stateDir);
    const files = await (await import("node:fs/promises")).readdir(this.stateDir);
    const runs: RunRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const run = await readJsonFile<RunRecord | undefined>(path.join(this.stateDir, file), undefined);
      if (run && run.sessionId === sessionId) {
        runs.push(run);
      }
    }
    runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return runs.slice(0, Math.max(1, limit));
  }

  async listRunEvents(run: RunRecord): Promise<RunEvent[]> {
    const day = run.createdAt.slice(0, 10);
    const filePath = path.join(this.workspaceDir, "runs", run.sessionId, `${day}.jsonl`);
    try {
      const raw = await readFile(filePath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent)
        .filter((event) => event.runId === run.runId);
    } catch {
      return [];
    }
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
