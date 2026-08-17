import { SCHEDULER_DEFAULT_TICK_MAX_MS } from "./constants.js";
import { SchedulerDeliveryStore } from "./deliveryStore.js";
import type { OutboundNotifier } from "./notifier.js";
import type { ScheduledTaskV1 } from "./types.js";
import { SchedulerTaskStore } from "./taskStore.js";

export interface ReminderExecutorOptions {
  taskStore: SchedulerTaskStore;
  deliveryStore: SchedulerDeliveryStore;
  notifier: OutboundNotifier;
  nowMs?: () => number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export class ReminderExecutor {
  private readonly nowMs: () => number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: ReminderExecutorOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 10));
    this.retryDelayMs = Math.max(0, Math.min(options.retryDelayMs ?? 250, SCHEDULER_DEFAULT_TICK_MAX_MS));
  }

  async execute(task: ScheduledTaskV1, cycleId: string): Promise<ScheduledTaskV1> {
    if (task.kind !== "reminder" || !task.reminderText || !task.notificationDestination) {
      throw new Error("invalid_reminder_task");
    }
    const delivery = await this.options.deliveryStore.ensurePending({
      taskId: task.id,
      cycleId,
      purpose: "reminder",
      destination: task.notificationDestination,
    });
    const text = `⏰ Reminder: ${task.reminderText}`;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const current = await this.options.deliveryStore.get(delivery.id);
      if (current?.status === "delivered") return this.complete(task, cycleId);
      const sending = await this.options.deliveryStore.claimSending(delivery.id, attempt > 0);
      if (!sending) {
        const afterClaim = await this.options.deliveryStore.get(delivery.id);
        if (afterClaim?.status === "delivered") return this.complete(task, cycleId);
        if (afterClaim?.status === "sending") {
          await delay(this.retryDelayMs);
          continue;
        }
        throw new Error("delivery_claim_unavailable");
      }
      try {
        const result = await this.options.notifier.send({
          destination: task.notificationDestination,
          text,
          deliveryId: sending.id,
        });
        await this.options.deliveryStore.markDelivered(sending.id, result.externalMessageId);
        return this.complete(task, cycleId);
      } catch {
        await this.options.deliveryStore.markFailed(sending.id, "notification_failed");
        if (attempt + 1 < this.maxAttempts) await delay(this.retryDelayMs);
      }
    }

    return this.options.taskStore.failCycle({
      taskId: task.id,
      cycleId,
      errorCode: "notification_failed",
      terminal: true,
    });
  }

  private async complete(task: ScheduledTaskV1, cycleId: string): Promise<ScheduledTaskV1> {
    const nextDueAt = task.intervalSeconds
      ? new Date(this.nowMs() + task.intervalSeconds * 1_000).toISOString()
      : undefined;
    return this.options.taskStore.completeCycle({ taskId: task.id, cycleId, nextDueAt });
  }
}

function delay(ms: number): Promise<void> {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

