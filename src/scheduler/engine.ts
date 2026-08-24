import { randomUUID } from "node:crypto";
import {
  SCHEDULER_DEFAULT_GLOBAL_WAKE_INTERVAL_MS,
  SCHEDULER_DEFAULT_TICK_MAX_MS,
  SCHEDULER_LEASE_RENEWAL_MS,
  SCHEDULER_MAX_CONCURRENCY,
} from "./constants.js";
import { systemSchedulerClock, type SchedulerClock } from "./clock.js";
import { SchedulerDeliveryStore } from "./deliveryStore.js";
import { ReminderExecutor } from "./reminder.js";
import { SchedulerTaskRunLog } from "./taskRunLog.js";
import type { ScheduledTaskV1 } from "./types.js";
import { SchedulerTaskStore } from "./taskStore.js";
import type { ScheduleTaskRequest, SchedulerTaskApi } from "./api.js";
import type { SchedulerProvenance } from "./notifier.js";
import type { TaskOwner } from "./types.js";
import type { WatchExecutor } from "./watch.js";
import type { WatchSnapshot } from "./probes/types.js";

export interface SchedulerRunStatus {
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
}

export interface SchedulerEngineDeps {
  taskStore: SchedulerTaskStore;
  deliveryStore: SchedulerDeliveryStore;
  taskRunLog: SchedulerTaskRunLog;
  reminderExecutor?: ReminderExecutor;
  watchExecutor?: WatchExecutor;
  executeWake?: (task: ScheduledTaskV1, cycleId: string, snapshot?: WatchSnapshot, observationDigest?: string) => Promise<ScheduledTaskV1>;
  lookupRun?: (runId: string) => Promise<SchedulerRunStatus | undefined>;
  requestRunCancellation?: (runId: string) => Promise<void>;
  clock?: SchedulerClock;
  maxConcurrency?: number;
  tickMaxMs?: number;
  globalWakeIntervalMs?: number;
}

export interface SchedulerStatusSnapshot {
  enabled: boolean;
  running: boolean;
  activeCount: number;
  maxConcurrency: number;
  lastTickAt?: string;
  nextTickAt?: string;
  taskCounts: Record<ScheduledTaskV1["status"], number>;
}

export interface SchedulerAgentEvent {
  workspaceId: string;
  paneId: string;
  agentKind: string;
  source: string;
  eventType: "progress" | "completed" | "failed" | "needs_approval";
}

export class SchedulerEngine implements SchedulerTaskApi {
  private readonly clock: SchedulerClock;
  private readonly maxConcurrency: number;
  private readonly tickMaxMs: number;
  private readonly globalWakeIntervalMs: number;
  private readonly instanceId = randomUUID();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private ticking = false;
  private activeCount = 0;
  private lastWakeStartedAt = Number.NEGATIVE_INFINITY;
  private lastTickAt?: string;
  private nextTickAt?: string;
  private readonly activeRuns = new Set<Promise<void>>();
  private stopPromise?: Promise<void>;

  constructor(private readonly deps: SchedulerEngineDeps) {
    this.clock = deps.clock ?? systemSchedulerClock;
    this.maxConcurrency = Math.max(1, Math.min(deps.maxConcurrency ?? 1, SCHEDULER_MAX_CONCURRENCY));
    this.tickMaxMs = Math.max(1_000, deps.tickMaxMs ?? SCHEDULER_DEFAULT_TICK_MAX_MS);
    this.globalWakeIntervalMs = Math.max(1_000, deps.globalWakeIntervalMs ?? SCHEDULER_DEFAULT_GLOBAL_WAKE_INTERVAL_MS);
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.deps.taskStore.init();
    await this.deps.deliveryStore.init();
    this.running = true;
    await this.recover();
    this.armTimer(0);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.running = false;
      if (this.timer) this.clock.clearTimeout(this.timer);
      this.timer = undefined;
      await Promise.allSettled(Array.from(this.activeRuns));
      this.activeRuns.clear();
      this.stopPromise = undefined;
    })();
    return this.stopPromise;
  }

  async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    this.lastTickAt = new Date(this.clock.nowMs()).toISOString();
    try {
      while (this.activeCount < this.maxConcurrency) {
        const due = await this.deps.taskStore.listDue(this.clock.nowMs(), this.maxConcurrency - this.activeCount);
        const candidate = due.find((task) => task.kind !== "wake_turn" || this.canStartWake());
        if (!candidate) break;
        const claim = await this.deps.taskStore.claim(candidate.id, candidate.updatedAt);
        if (!claim.claimed) continue;
        if (claim.task.kind === "wake_turn") this.lastWakeStartedAt = this.clock.nowMs();
        await this.deps.taskRunLog.append({ version: 1, taskId: claim.task.id, cycleId: claim.cycleId, event: "claimed", timestamp: new Date(this.clock.nowMs()).toISOString(), attempt: claim.task.cycleCount });
        const run = this.runClaim(claim.task, claim.cycleId);
        this.activeRuns.add(run);
        this.activeCount += 1;
        void run.finally(() => {
          this.activeRuns.delete(run);
          this.activeCount -= 1;
          if (this.running) this.armTimer(0);
        });
      }
    } finally {
      this.ticking = false;
      this.armTimer(this.nextDelayMs());
    }
  }

  async recover(): Promise<void> {
    const tasks = await this.deps.taskStore.listAll({ includeTerminal: false });
    const now = this.clock.nowMs();
    for (const task of tasks) {
      if (task.status !== "claimed" && task.status !== "running") continue;
      const leaseExpired = !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= now;
      if (!leaseExpired) continue;
      if (task.activeRunId && this.deps.lookupRun) {
        const run = await this.deps.lookupRun(task.activeRunId);
        if (run?.status === "completed") {
          await this.deps.taskStore.reconcile({ taskId: task.id, cycleId: task.activeCycleId!, action: "complete" });
          continue;
        }
        if (run?.status === "failed" || run?.status === "cancelled") {
          await this.deps.taskStore.reconcile({ taskId: task.id, cycleId: task.activeCycleId!, action: "fail", errorCode: "scheduled_run_recovered_failed", terminal: true });
          continue;
        }
      }
      if (task.activeCycleId) {
        await this.deps.taskStore.reconcile({
          taskId: task.id,
          cycleId: task.activeCycleId,
          action: "reclaim",
          dueAt: new Date(now).toISOString(),
          errorCode: "lease_expired_reclaimed",
        });
      }
    }
  }

  async handleAgentEvent(event: SchedulerAgentEvent): Promise<void> {
    const tasks = await this.deps.taskStore.listAll({ includeTerminal: false });
    const now = new Date(this.clock.nowMs()).toISOString();
    for (const task of tasks) {
      if (task.kind === "watch" && task.watch?.type === "herdr_agent") {
        if (task.watch.workspaceId === event.workspaceId && task.watch.paneId === event.paneId) {
          await this.deps.taskStore.nudge(task.id, now);
        }
      }
      if (task.kind === "event_subscription" && task.eventMatch && eventMatches(task.eventMatch, event)) {
        await this.deps.taskStore.nudge(task.id, now);
      }
    }
    if (this.running) await this.tick();
  }

  async cancel(taskId: string, owner: Parameters<SchedulerTaskStore["cancel"]>[1]): Promise<ScheduledTaskV1> {
    const task = await this.deps.taskStore.get(taskId);
    if (task?.activeRunId && this.deps.requestRunCancellation) {
      await this.deps.requestRunCancellation(task.activeRunId);
    }
    return this.deps.taskStore.cancel(taskId, owner);
  }

  async get(taskId: string): Promise<ScheduledTaskV1 | undefined> {
    return this.deps.taskStore.get(taskId);
  }

  async attachRun(taskId: string, cycleId: string, runId: string): Promise<ScheduledTaskV1> {
    return this.deps.taskStore.markRunning(taskId, cycleId, runId);
  }

  async complete(taskId: string, cycleId: string, nextDueAt?: string, observationDigest?: string, completionSummary?: string): Promise<ScheduledTaskV1> {
    return this.deps.taskStore.completeCycle({ taskId, cycleId, nextDueAt, observationDigest, completionSummary });
  }

  async fail(taskId: string, cycleId: string, errorCode: string): Promise<ScheduledTaskV1> {
    return this.deps.taskStore.failCycle({ taskId, cycleId, errorCode, terminal: true });
  }

  async schedule(request: ScheduleTaskRequest, provenance: SchedulerProvenance, sessionId: string, createdByRunId: string): Promise<ScheduledTaskV1> {
    if (provenance.origin === "scheduler") throw new Error("scheduler_cannot_schedule_tasks");
    const owner: TaskOwner = { sessionId, principalId: provenance.principalId, channelKey: provenance.channelKey };
    const active = await this.deps.taskStore.listAll({ includeTerminal: false });
    const principalCount = active.filter((task) => task.owner.principalId === owner.principalId).length;
    if (principalCount >= 20) throw new Error("scheduler_principal_quota_exceeded");
    if (active.length >= 100) throw new Error("scheduler_global_quota_exceeded");
    return this.deps.taskStore.create({
      ...request,
      owner,
      createdByRunId,
      notificationDestination: {
        channelKey: provenance.channelKey ?? `web:${sessionId}`,
        principalId: provenance.principalId,
      },
    });
  }

  async list(owner: TaskOwner, includeTerminal = false): Promise<ScheduledTaskV1[]> {
    return this.deps.taskStore.listForOwner(owner, { includeTerminal });
  }

  status(): SchedulerStatusSnapshot {
    return {
      enabled: true,
      running: this.running,
      activeCount: this.activeCount,
      maxConcurrency: this.maxConcurrency,
      lastTickAt: this.lastTickAt,
      nextTickAt: this.nextTickAt,
      taskCounts: {
        pending: 0,
        claimed: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        expired: 0,
      },
    };
  }

  async statusWithTasks(): Promise<SchedulerStatusSnapshot> {
    const tasks = await this.deps.taskStore.listAll({ includeTerminal: true });
    const counts: SchedulerStatusSnapshot["taskCounts"] = {
      pending: 0,
      claimed: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      expired: 0,
    };
    for (const task of tasks) counts[task.status] += 1;
    return { ...this.status(), taskCounts: counts };
  }

  private async runClaim(task: ScheduledTaskV1, cycleId: string): Promise<void> {
    let renewal: { cancel(): void } | undefined;
    try {
      await this.deps.taskStore.markRunning(task.id, cycleId);
      await this.deps.taskRunLog.append({ version: 1, taskId: task.id, cycleId, event: "started", timestamp: new Date(this.clock.nowMs()).toISOString(), attempt: task.cycleCount });
      renewal = this.scheduleLeaseRenewal(task.id, cycleId);
      let result: ScheduledTaskV1;
      if (task.kind === "reminder") {
        if (!this.deps.reminderExecutor) throw new Error("reminder_executor_unavailable");
        result = await this.deps.reminderExecutor.execute(task, cycleId);
      } else if (task.kind === "watch") {
        if (!this.deps.watchExecutor) throw new Error("watch_executor_unavailable");
        result = await this.deps.watchExecutor.execute(task, cycleId);
      } else if (this.deps.executeWake) {
        result = await this.deps.executeWake(task, cycleId);
      } else {
        result = await this.deps.taskStore.failCycle({ taskId: task.id, cycleId, errorCode: "scheduler_executor_unavailable", terminal: true });
      }
      await this.deps.taskRunLog.append({ version: 1, taskId: task.id, cycleId, event: "completed", timestamp: new Date(this.clock.nowMs()).toISOString(), outcome: result.status === "failed" ? "terminal_failure" : "success", attempt: task.cycleCount });
    } catch {
      try {
        const failed = await this.deps.taskStore.failCycle({ taskId: task.id, cycleId, errorCode: "scheduler_cycle_failed", terminal: true });
        await this.deps.taskRunLog.append({ version: 1, taskId: task.id, cycleId, event: "failed", timestamp: new Date(this.clock.nowMs()).toISOString(), outcome: "terminal_failure", errorCode: failed.lastErrorCode, attempt: task.cycleCount });
      } catch {
        // A concurrent recovery may already have reconciled this cycle.
      }
    } finally {
      renewal?.cancel();
    }
  }

  private scheduleLeaseRenewal(taskId: string, cycleId: string): { cancel(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const renew = () => {
      void this.deps.taskStore.renewLease(taskId, cycleId).then((renewed) => {
        if (renewed && this.running && !cancelled) timer = this.clock.setTimeout(renew, SCHEDULER_LEASE_RENEWAL_MS);
      });
    };
    timer = this.clock.setTimeout(renew, SCHEDULER_LEASE_RENEWAL_MS);
    return {
      cancel: () => {
        cancelled = true;
        if (timer) this.clock.clearTimeout(timer);
      },
    };
  }

  private canStartWake(): boolean {
    return this.clock.nowMs() - this.lastWakeStartedAt >= this.globalWakeIntervalMs;
  }

  private nextDelayMs(): number {
    return Math.min(this.tickMaxMs, this.tickMaxMs);
  }

  private armTimer(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(delayMs, this.tickMaxMs));
    this.nextTickAt = new Date(this.clock.nowMs() + delay).toISOString();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }
}

function eventMatches(match: NonNullable<ScheduledTaskV1["eventMatch"]>, event: SchedulerAgentEvent): boolean {
  return (!match.workspaceId || match.workspaceId === event.workspaceId) &&
    (!match.paneId || match.paneId === event.paneId) &&
    (!match.agentKind || match.agentKind === event.agentKind) &&
    (!match.source || match.source === event.source) &&
    match.eventTypes.includes(event.eventType);
}
