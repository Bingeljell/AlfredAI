import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  SCHEDULER_CLAIM_LEASE_MS,
  SCHEDULER_DIRECTORY,
  SCHEDULER_LOCK_FILE,
  SCHEDULER_LOCK_TTL_MS,
  SCHEDULER_MAX_HORIZON_MS,
  SCHEDULER_TASKS_FILE,
  SCHEDULER_TASK_RUNS_DIRECTORY,
  SCHEDULER_MIN_DELAY_MS,
  SCHEDULER_MAX_CYCLES,
  SCHEDULER_DEFAULT_WATCH_LIFETIME_MS,
  SCHEDULER_MAX_WATCH_LIFETIME_MS,
} from "./constants.js";
import { canonicalUtc, CreateScheduledTaskSchema, ScheduledTaskSchema, SchedulerSnapshotSchema } from "./schemas.js";
import type {
  ClaimResult,
  CompleteCycleInput,
  CreateScheduledTaskInput,
  FailCycleInput,
  ReconcileInput,
  ScheduledTaskV1,
  SchedulerSnapshot,
  TaskOwner,
} from "./types.js";
import { redactValue } from "../utils/redact.js";
import { TaskTranscriptStore } from "./taskTranscript.js";

interface LockRecord {
  ownerId: string;
  pid: number;
  createdAtMs: number;
  expiresAtMs: number;
}

export class SchedulerStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SchedulerStoreError";
  }
}

export interface SchedulerTaskStoreOptions {
  workspaceDir: string;
  nowMs?: () => number;
  instanceId?: string;
  transcriptStore?: TaskTranscriptStore;
}

export class SchedulerTaskStore {
  readonly schedulerDir: string;
  readonly tasksPath: string;
  readonly lockPath: string;
  readonly taskRunsDir: string;
  readonly transcriptStore: TaskTranscriptStore;
  private readonly nowMs: () => number;
  private readonly instanceId: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: SchedulerTaskStoreOptions) {
    this.schedulerDir = path.join(options.workspaceDir, SCHEDULER_DIRECTORY);
    this.tasksPath = path.join(this.schedulerDir, SCHEDULER_TASKS_FILE);
    this.lockPath = path.join(this.schedulerDir, SCHEDULER_LOCK_FILE);
    this.taskRunsDir = path.join(this.schedulerDir, SCHEDULER_TASK_RUNS_DIRECTORY);
    this.transcriptStore = options.transcriptStore ?? new TaskTranscriptStore(options.workspaceDir);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.instanceId = options.instanceId ?? randomUUID();
  }

  async init(): Promise<void> {
    await mkdir(this.schedulerDir, { recursive: true, mode: 0o700 });
    await chmod(this.schedulerDir, 0o700);
    await mkdir(this.taskRunsDir, { recursive: true, mode: 0o700 });
    await chmod(this.taskRunsDir, 0o700);
    try {
      await readFile(this.tasksPath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.writeSnapshot({ version: 1, tasks: [] });
    }
  }

  async get(id: string): Promise<ScheduledTaskV1 | undefined> {
    const snapshot = await this.readSnapshot();
    const task = snapshot.tasks.find((candidate) => candidate.id === id);
    return task ? clone(task) : undefined;
  }

  async listForOwner(owner: TaskOwner, options?: { includeTerminal?: boolean }): Promise<ScheduledTaskV1[]> {
    const snapshot = await this.readSnapshot();
    return snapshot.tasks
      .filter((task) => task.owner.principalId === owner.principalId && task.owner.sessionId === owner.sessionId)
      .filter((task) => options?.includeTerminal || !isTerminal(task.status))
      .map(clone);
  }

  async listAll(options?: { includeTerminal?: boolean }): Promise<ScheduledTaskV1[]> {
    const snapshot = await this.readSnapshot();
    return snapshot.tasks
      .filter((task) => options?.includeTerminal || !isTerminal(task.status))
      .map(clone);
  }

  async listDue(nowMs = this.nowMs(), limit = 50): Promise<ScheduledTaskV1[]> {
    const snapshot = await this.readSnapshot();
    return snapshot.tasks
      .filter((task) => task.status === "pending" && Date.parse(task.dueAt) <= nowMs)
      .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
      .slice(0, limit)
      .map(clone);
  }

  async nudge(id: string, dueAt = canonicalUtc(this.nowMs())): Promise<boolean> {
    return this.mutate((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === id);
      if (!task || task.status !== "pending") return false;
      task.dueAt = dueAt;
      task.updatedAt = canonicalUtc(this.nowMs());
      return true;
    });
  }

  async create(input: CreateScheduledTaskInput): Promise<ScheduledTaskV1> {
    const parsed = CreateScheduledTaskSchema.parse(input);
    const now = this.nowMs();
    const dueAtMs = Date.parse(parsed.dueAt);
    if (dueAtMs - now < SCHEDULER_MIN_DELAY_MS) {
      throw new SchedulerStoreError("scheduled time must be at least 5 seconds in the future");
    }
    if (dueAtMs - now > SCHEDULER_MAX_HORIZON_MS) {
      throw new SchedulerStoreError("scheduled time exceeds the maximum horizon");
    }
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= dueAtMs) {
      throw new SchedulerStoreError("expiresAt must be after dueAt");
    }
    if (parsed.kind === "watch") {
      const expiresAt = parsed.expiresAt ? Date.parse(parsed.expiresAt) : now + SCHEDULER_DEFAULT_WATCH_LIFETIME_MS;
      if (expiresAt - now > SCHEDULER_MAX_WATCH_LIFETIME_MS) throw new SchedulerStoreError("watch lifetime exceeds the maximum");
      parsed.expiresAt = canonicalUtc(expiresAt);
    }
    const task = ScheduledTaskSchema.parse({
      ...parsed,
      version: 1,
      id: randomUUID(),
      status: "pending",
      createdAt: canonicalUtc(now),
      updatedAt: canonicalUtc(now),
      cycleCount: 0,
      consecutiveFailures: 0,
      intervalMode: parsed.intervalSeconds === undefined ? undefined : "fixed_delay",
    });
    return this.mutate((snapshot) => {
      snapshot.tasks.push(task);
      return clone(task);
    });
  }

  async claim(id: string, expectedUpdatedAt?: string): Promise<ClaimResult> {
    const result = await this.mutate((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === id);
      if (!task) return { claimed: false, reason: "not_found" } as const;
      if (expectedUpdatedAt !== undefined && task.updatedAt !== expectedUpdatedAt) {
        return { claimed: false, reason: "stale_update" } as const;
      }
      const now = this.nowMs();
      if (task.status !== "pending") return { claimed: false, reason: "not_pending" } as const;
      if (Date.parse(task.dueAt) > now) return { claimed: false, reason: "not_due" } as const;
      if (task.expiresAt && Date.parse(task.expiresAt) <= now) {
        transitionToTerminal(task, "expired", now, "expired");
        return { claimed: false, reason: "expired" } as const;
      }
      if (task.cycleCount >= Math.min(task.maxCycles, SCHEDULER_MAX_CYCLES)) {
        transitionToTerminal(task, "expired", now, "cycle_limit");
        return { claimed: false, reason: "cycle_limit" } as const;
      }
      const cycleNumber = task.cycleCount + 1;
      const cycleId = `${task.id}:${cycleNumber}`;
      task.cycleCount = cycleNumber;
      task.activeCycleId = cycleId;
      task.activeRunId = undefined;
      task.claimOwner = this.instanceId;
      task.leaseExpiresAt = canonicalUtc(now + SCHEDULER_CLAIM_LEASE_MS);
      task.status = "claimed";
      task.updatedAt = canonicalUtc(now);
      return { claimed: true, task: clone(task), cycleId } as const;
    });
    if (!result.claimed && (result.reason === "expired" || result.reason === "cycle_limit")) {
      const task = await this.get(id);
      if (task) await this.writeTerminalSummary(task);
    }
    return result;
  }

  async markRunning(id: string, cycleId: string, runId?: string): Promise<ScheduledTaskV1> {
    return this.mutate((snapshot) => {
      const task = requireTask(snapshot, id);
      requireActiveCycle(task, cycleId);
      if (task.claimOwner !== this.instanceId) throw new SchedulerStoreError("scheduler claim is owned by another instance");
      if (task.status !== "claimed" && task.status !== "running") throw new SchedulerStoreError("task is not claimable");
      task.status = "running";
      task.activeRunId = runId ?? task.activeRunId;
      task.lastStartedAt = task.lastStartedAt ?? canonicalUtc(this.nowMs());
      task.updatedAt = canonicalUtc(this.nowMs());
      return clone(task);
    });
  }

  async renewLease(id: string, cycleId: string): Promise<boolean> {
    return this.mutate((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === id);
      if (!task || task.activeCycleId !== cycleId || task.claimOwner !== this.instanceId) return false;
      if (task.status !== "claimed" && task.status !== "running") return false;
      task.leaseExpiresAt = canonicalUtc(this.nowMs() + SCHEDULER_CLAIM_LEASE_MS);
      task.updatedAt = canonicalUtc(this.nowMs());
      return true;
    });
  }

  async completeCycle(input: CompleteCycleInput): Promise<ScheduledTaskV1> {
    const result = await this.mutate((snapshot) => {
      const task = requireTask(snapshot, input.taskId);
      requireActiveCycle(task, input.cycleId);
      const now = input.completedAt ? Date.parse(input.completedAt) : this.nowMs();
      if (!Number.isFinite(now)) throw new SchedulerStoreError("invalid completion timestamp");
      task.consecutiveFailures = 0;
      task.lastCompletedAt = canonicalUtc(now);
      task.lastObservationDigest = input.observationDigest;
      task.lastErrorCode = undefined;
      if (!input.nextDueAt || task.cycleCount >= task.maxCycles || (task.expiresAt && Date.parse(input.nextDueAt) >= Date.parse(task.expiresAt))) {
        transitionToTerminal(task, "completed", now);
      } else {
        task.status = "pending";
        task.dueAt = input.nextDueAt;
        clearActiveState(task);
        task.updatedAt = canonicalUtc(now);
      }
      return clone(task);
    });
    await this.writeTerminalSummary(result, input.completionSummary);
    return result;
  }

  async failCycle(input: FailCycleInput): Promise<ScheduledTaskV1> {
    const result = await this.mutate((snapshot) => {
      const task = requireTask(snapshot, input.taskId);
      requireActiveCycle(task, input.cycleId);
      const now = this.nowMs();
      task.consecutiveFailures = Math.min(task.consecutiveFailures + 1, SCHEDULER_MAX_CYCLES);
      task.lastErrorCode = input.errorCode;
      if (input.terminal || !input.retryAt || task.cycleCount >= task.maxCycles || (task.expiresAt && Date.parse(input.retryAt) >= Date.parse(task.expiresAt))) {
        transitionToTerminal(task, "failed", now, input.errorCode);
      } else {
        task.status = "pending";
        task.dueAt = input.retryAt;
        clearActiveState(task);
        task.updatedAt = canonicalUtc(now);
      }
      return clone(task);
    });
    await this.writeTerminalSummary(result);
    return result;
  }

  async cancel(id: string, owner: TaskOwner): Promise<ScheduledTaskV1> {
    const result = await this.mutate((snapshot) => {
      const task = requireTask(snapshot, id);
      if (task.owner.principalId !== owner.principalId || task.owner.sessionId !== owner.sessionId) {
        throw new SchedulerStoreError("task does not belong to the caller");
      }
      if (!isTerminal(task.status)) {
        transitionToTerminal(task, "cancelled", this.nowMs(), "cancelled");
      }
      return clone(task);
    });
    await this.writeTerminalSummary(result);
    return result;
  }

  async reconcile(input: ReconcileInput): Promise<ScheduledTaskV1 | undefined> {
    const result = await this.mutate((snapshot) => {
      const task = snapshot.tasks.find((candidate) => candidate.id === input.taskId);
      if (!task) return undefined;
      if (input.action === "expire") {
        transitionToTerminal(task, "expired", this.nowMs(), input.errorCode ?? "expired");
        return clone(task);
      }
      if (task.activeCycleId !== input.cycleId) return clone(task);
      if (input.action === "reclaim") {
        task.status = "pending";
        task.dueAt = input.dueAt;
        task.lastErrorCode = input.errorCode;
        clearActiveState(task);
        task.updatedAt = canonicalUtc(this.nowMs());
      } else if (input.action === "complete") {
        task.lastCompletedAt = canonicalUtc(input.completedAt ? Date.parse(input.completedAt) : this.nowMs());
        task.lastObservationDigest = input.observationDigest;
        transitionToTerminalOrPending(task, input.nextDueAt, this.nowMs());
      } else {
        task.lastErrorCode = input.errorCode;
        if (input.terminal || !input.retryAt) transitionToTerminal(task, "failed", this.nowMs(), input.errorCode);
        else {
          task.status = "pending";
          task.dueAt = input.retryAt;
          clearActiveState(task);
          task.updatedAt = canonicalUtc(this.nowMs());
        }
      }
      return clone(task);
    });
    if (result) await this.writeTerminalSummary(result);
    return result;
  }

  private async writeTerminalSummary(task: ScheduledTaskV1, summary?: string): Promise<void> {
    if (!isTerminal(task.status)) return;
    try {
      await this.transcriptStore.writeSummary({
        taskId: task.id,
        label: task.label,
        status: task.status,
        cycleCount: task.cycleCount,
        completedAt: task.lastCompletedAt ?? task.updatedAt,
        errorCode: task.lastErrorCode,
        summary,
      });
    } catch (error) {
      console.error(`[scheduler] failed to persist task summary for ${task.id}:`, error);
    }
  }

  private async readSnapshot(): Promise<SchedulerSnapshot> {
    try {
      const raw = await readFile(this.tasksPath, "utf8");
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        await this.quarantine("invalid-json");
        throw new SchedulerStoreError("scheduler task snapshot is malformed", { cause: error });
      }
      const parsed = SchedulerSnapshotSchema.safeParse(value);
      if (!parsed.success) {
        await this.quarantine("invalid-schema");
        throw new SchedulerStoreError("scheduler task snapshot failed validation", { cause: parsed.error });
      }
      return clone(parsed.data);
    } catch (error) {
      if (isMissing(error)) return { version: 1, tasks: [] };
      if (error instanceof SchedulerStoreError) throw error;
      throw new SchedulerStoreError("scheduler task snapshot could not be read", { cause: error });
    }
  }

  private async mutate<T>(mutation: (snapshot: SchedulerSnapshot) => T): Promise<T> {
    const run = this.mutationTail.then(async () => this.withLock(async () => {
      const snapshot = await this.readSnapshot();
      const result = mutation(snapshot);
      const validated = SchedulerSnapshotSchema.parse(redactSnapshot(snapshot));
      await this.writeSnapshot(validated);
      return result;
    }), async () => this.withLock(async () => {
      const snapshot = await this.readSnapshot();
      const result = mutation(snapshot);
      const validated = SchedulerSnapshotSchema.parse(redactSnapshot(snapshot));
      await this.writeSnapshot(validated);
      return result;
    }));
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.schedulerDir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const lock = await this.tryAcquireLock();
      if (lock) {
        try {
          return await operation();
        } finally {
          await this.releaseLock(lock);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new SchedulerStoreError("timed out waiting for scheduler task lock");
  }

  private async tryAcquireLock(): Promise<LockRecord | undefined> {
    const now = this.nowMs();
    const record: LockRecord = { ownerId: this.instanceId, pid: process.pid, createdAtMs: now, expiresAtMs: now + SCHEDULER_LOCK_TTL_MS };
    try {
      const handle = await open(this.lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return record;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const stale = await this.readLock();
      if (stale && stale.expiresAtMs <= now) {
        try {
          await unlink(this.lockPath);
        } catch (unlinkError) {
          if (!isMissing(unlinkError)) throw unlinkError;
        }
      }
      return undefined;
    }
  }

  private async readLock(): Promise<LockRecord | undefined> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const value: unknown = JSON.parse(raw);
      if (!isLockRecord(value)) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private async releaseLock(record: LockRecord): Promise<void> {
    const current = await this.readLock();
    if (!current || current.ownerId !== record.ownerId || current.pid !== record.pid || current.createdAtMs !== record.createdAtMs) return;
    try {
      await unlink(this.lockPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async writeSnapshot(snapshot: SchedulerSnapshot): Promise<void> {
    await mkdir(this.schedulerDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(this.schedulerDir, `${SCHEDULER_TASKS_FILE}.${this.instanceId}.${randomUUID()}.tmp`);
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.tasksPath);
    try {
      const directoryHandle = await open(this.schedulerDir, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Directory fsync is not available on every supported filesystem.
    }
  }

  private async quarantine(reason: string): Promise<void> {
    const quarantinePath = `${this.tasksPath}.corrupt-${this.nowMs()}-${reason}-${randomUUID()}`;
    try {
      await rename(this.tasksPath, quarantinePath);
      await chmod(quarantinePath, 0o600);
    } catch {
      // A concurrent writer may have replaced the file; the next read will validate it.
    }
  }
}

function requireTask(snapshot: SchedulerSnapshot, id: string): ScheduledTaskV1 {
  const task = snapshot.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new SchedulerStoreError("scheduled task was not found");
  return task;
}

function requireActiveCycle(task: ScheduledTaskV1, cycleId: string): void {
  if (task.activeCycleId !== cycleId || (task.status !== "claimed" && task.status !== "running")) {
    throw new SchedulerStoreError("scheduled task cycle is no longer active");
  }
}

function clearActiveState(task: ScheduledTaskV1): void {
  task.activeCycleId = undefined;
  task.activeRunId = undefined;
  task.claimOwner = undefined;
  task.leaseExpiresAt = undefined;
}

function transitionToTerminal(task: ScheduledTaskV1, status: "completed" | "failed" | "cancelled" | "expired", nowMs: number, errorCode?: string): void {
  task.status = status;
  task.lastErrorCode = errorCode;
  clearActiveState(task);
  task.updatedAt = canonicalUtc(nowMs);
}

function transitionToTerminalOrPending(task: ScheduledTaskV1, nextDueAt: string | undefined, nowMs: number): void {
  if (!nextDueAt || task.cycleCount >= task.maxCycles || (task.expiresAt && Date.parse(nextDueAt) >= Date.parse(task.expiresAt))) {
    transitionToTerminal(task, "completed", nowMs);
  } else {
    task.status = "pending";
    task.dueAt = nextDueAt;
    clearActiveState(task);
    task.updatedAt = canonicalUtc(nowMs);
  }
}

function isTerminal(status: ScheduledTaskV1["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "expired";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LockRecord>;
  return typeof record.ownerId === "string" && record.ownerId.length > 0 && Number.isInteger(record.pid) &&
    typeof record.createdAtMs === "number" && Number.isFinite(record.createdAtMs) &&
    typeof record.expiresAtMs === "number" && Number.isFinite(record.expiresAtMs) && record.expiresAtMs >= record.createdAtMs;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function redactSnapshot(snapshot: SchedulerSnapshot): SchedulerSnapshot {
  const textFields = snapshot.tasks.map((task) => ({
    label: task.label,
    instruction: task.instruction,
    reminderText: task.reminderText,
    lastErrorCode: task.lastErrorCode,
    lastObservationDigest: task.lastObservationDigest,
    watch: task.watch,
    eventMatch: task.eventMatch,
  }));
  const redactedFields = redactValue(textFields) as typeof textFields;
  const persisted = clone(snapshot);
  persisted.tasks.forEach((task, index) => {
    const redacted = redactedFields[index];
    if (!redacted) return;
    task.label = redacted.label;
    task.instruction = redacted.instruction;
    task.reminderText = redacted.reminderText;
    task.lastErrorCode = redacted.lastErrorCode;
    task.lastObservationDigest = redacted.lastObservationDigest;
    task.watch = redacted.watch;
    task.eventMatch = redacted.eventMatch;
  });
  return persisted;
}
