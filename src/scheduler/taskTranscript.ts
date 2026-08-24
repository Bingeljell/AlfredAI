import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunStatus } from "../types.js";
import type { ScheduledTaskV1 } from "./types.js";
import { redactValue } from "../utils/redact.js";

export const TASK_TRANSCRIPT_MAX_ENTRIES = 128;
export const TASK_TRANSCRIPT_MAX_BYTES = 256 * 1024;
export const TASK_TRANSCRIPT_FIELD_MAX_CHARS = 6_000;
export const TASK_SUMMARY_MAX_CHARS = 8_000;

export type TaskTranscriptEvent = "turn_started" | "turn_completed" | "turn_failed";

export interface TaskTranscriptEntry {
  version: 1;
  taskId: string;
  cycleId: string;
  runId: string;
  event: TaskTranscriptEvent;
  timestamp: string;
  status?: RunStatus;
  instruction?: string;
  assistantText?: string;
  error?: string;
}

export interface TaskSummaryInput {
  taskId: string;
  label: string;
  status: ScheduledTaskV1["status"];
  cycleCount: number;
  completedAt: string;
  errorCode?: string;
  summary?: string;
}

export class TaskTranscriptStore {
  readonly tasksDirectory: string;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly entryCounts = new Map<string, number>();

  constructor(workspaceDir: string) {
    this.tasksDirectory = path.join(workspaceDir, "tasks");
  }

  transcriptPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "transcript.jsonl");
  }

  summaryPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "task_summary.md");
  }

  async append(entry: TaskTranscriptEntry): Promise<void> {
    const safeEntry = normalizeEntry(entry);
    await this.enqueue(entry.taskId, async () => {
      const directory = this.taskDirectory(safeEntry.taskId);
      await this.prepareDirectory(directory);
      const line = `${JSON.stringify(redactValue(safeEntry))}\n`;
      await this.appendBounded(this.transcriptPath(safeEntry.taskId), line, safeEntry.taskId);
    });
  }

  async writeSummary(input: TaskSummaryInput): Promise<void> {
    const safeInput = normalizeSummary(input);
    await this.enqueue(input.taskId, async () => {
      const directory = this.taskDirectory(safeInput.taskId);
      await this.prepareDirectory(directory);
      const summary = buildSummary(safeInput);
      await this.atomicWrite(this.summaryPath(safeInput.taskId), summary);
    });
  }

  private async enqueue(taskId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(taskId, next.then(() => undefined, () => undefined));
    await next;
  }

  private async appendBounded(filePath: string, line: string, taskId: string): Promise<void> {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const existingBytes = await this.fileSize(filePath);
    let entryCount = this.entryCounts.get(taskId);
    if (entryCount === undefined) {
      entryCount = existingBytes > TASK_TRANSCRIPT_MAX_BYTES ? TASK_TRANSCRIPT_MAX_ENTRIES : await this.countEntries(filePath);
      this.entryCounts.set(taskId, entryCount);
    }

    if (
      entryCount < TASK_TRANSCRIPT_MAX_ENTRIES &&
      existingBytes + lineBytes <= TASK_TRANSCRIPT_MAX_BYTES
    ) {
      await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600);
      this.entryCounts.set(taskId, entryCount + 1);
      return;
    }

    const retained = existingBytes <= TASK_TRANSCRIPT_MAX_BYTES
      ? (await readFile(filePath, "utf8")).split("\n").filter(Boolean).slice(-(TASK_TRANSCRIPT_MAX_ENTRIES - 1))
      : [];
    retained.push(line.trimEnd());
    while (retained.length > 1 && Buffer.byteLength(`${retained.join("\n")}\n`, "utf8") > TASK_TRANSCRIPT_MAX_BYTES) {
      retained.shift();
    }
    await this.atomicWrite(filePath, `${retained.join("\n")}\n`);
    this.entryCounts.set(taskId, retained.length);
  }

  private async countEntries(filePath: string): Promise<number> {
    try {
      return (await readFile(filePath, "utf8")).split("\n").filter(Boolean).length;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  private async fileSize(filePath: string): Promise<number> {
    try {
      return (await stat(filePath)).size;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  private async prepareDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  }

  private taskDirectory(taskId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(taskId)) {
      throw new Error("invalid_task_id");
    }
    return path.join(this.tasksDirectory, taskId);
  }
}

function normalizeEntry(entry: TaskTranscriptEntry): TaskTranscriptEntry {
  return {
    version: 1,
    taskId: clip(entry.taskId, 256),
    cycleId: clip(entry.cycleId, 512),
    runId: clip(entry.runId, 256),
    event: entry.event,
    timestamp: clip(entry.timestamp, 64),
    status: entry.status,
    instruction: clipOptional(entry.instruction),
    assistantText: clipOptional(entry.assistantText),
    error: clipOptional(entry.error),
  };
}

function normalizeSummary(input: TaskSummaryInput): TaskSummaryInput {
  return {
    taskId: clip(input.taskId, 256),
    label: clip(input.label, 256),
    status: input.status,
    cycleCount: Math.max(0, Math.min(10_000, Math.trunc(input.cycleCount))),
    completedAt: clip(input.completedAt, 64),
    errorCode: clipOptional(input.errorCode, 256),
    summary: clipOptional(input.summary, TASK_SUMMARY_MAX_CHARS),
  };
}

function buildSummary(input: TaskSummaryInput): string {
  const result = input.summary || (input.errorCode ? `Task ended with error: ${input.errorCode}` : `Task reached terminal status: ${input.status}.`);
  const body = [
    "# Task summary",
    "",
    `- Task ID: ${input.taskId}`,
    `- Label: ${input.label}`,
    `- Status: ${input.status}`,
    `- Cycles: ${input.cycleCount}`,
    `- Completed at: ${input.completedAt}`,
    ...(input.errorCode ? [`- Error code: ${input.errorCode}`] : []),
    "",
    "## Result",
    "",
    result,
    "",
  ].join("\n");
  return `${String(redactValue(body)).slice(0, TASK_SUMMARY_MAX_CHARS)}\n`;
}

function clip(value: string, maxChars: number): string {
  return value.replace(/\0/g, "").slice(0, maxChars);
}

function clipOptional(value: string | undefined, maxChars = TASK_TRANSCRIPT_FIELD_MAX_CHARS): string | undefined {
  return value === undefined ? undefined : clip(value, maxChars);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
