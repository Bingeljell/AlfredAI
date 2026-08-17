import { SCHEDULER_MIN_INTERVAL_MS } from "./constants.js";
import { SchedulerDeliveryStore } from "./deliveryStore.js";
import type { OutboundNotifier } from "./notifier.js";
import type { ProbeResult } from "./probes/types.js";
import type { ScheduledTaskV1 } from "./types.js";
import { SchedulerTaskStore } from "./taskStore.js";

export interface WatchExecutorOptions {
  taskStore: SchedulerTaskStore;
  deliveryStore: SchedulerDeliveryStore;
  notifier: OutboundNotifier;
  probe: (task: ScheduledTaskV1, previousDigest?: string) => Promise<ProbeResult>;
  executeWake?: (task: ScheduledTaskV1, cycleId: string) => Promise<ScheduledTaskV1>;
  nowMs?: () => number;
}

export class WatchExecutor {
  private readonly nowMs: () => number;

  constructor(private readonly options: WatchExecutorOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async execute(task: ScheduledTaskV1, cycleId: string): Promise<ScheduledTaskV1> {
    if (task.kind !== "watch") throw new Error("invalid_watch_task");
    const observation = await this.options.probe(task, task.lastObservationDigest);
    if (observation.status === "unknown") {
      const retryAt = new Date(this.nowMs() + this.intervalMs(task)).toISOString();
      return this.options.taskStore.failCycle({
        taskId: task.id,
        cycleId,
        errorCode: observation.errorCode ?? "watch_probe_unknown",
        retryAt,
        terminal: task.consecutiveFailures >= 2,
      });
    }

    if (observation.terminal) {
      await this.notify(task, cycleId, observation);
      if (observation.status === "completed") {
        return this.options.taskStore.completeCycle({ taskId: task.id, cycleId, observationDigest: observation.digest });
      }
      return this.options.taskStore.failCycle({ taskId: task.id, cycleId, errorCode: observation.status === "missing" ? "watch_target_missing" : "watch_target_failed", terminal: true });
    }

    if (observation.changed && task.instruction && this.options.executeWake) {
      return this.options.executeWake(task, cycleId);
    }

    return this.options.taskStore.completeCycle({
      taskId: task.id,
      cycleId,
      nextDueAt: new Date(this.nowMs() + this.intervalMs(task)).toISOString(),
      observationDigest: observation.digest,
    });
  }

  private async notify(task: ScheduledTaskV1, cycleId: string, observation: ProbeResult): Promise<void> {
    if (!task.notificationDestination) throw new Error("watch_notification_destination_missing");
    const delivery = await this.options.deliveryStore.ensurePending({
      taskId: task.id,
      cycleId,
      purpose: "watch_terminal",
      destination: task.notificationDestination,
    });
    if (delivery.status === "delivered") return;
    const sending = await this.options.deliveryStore.claimSending(delivery.id, true);
    if (!sending) throw new Error("watch_delivery_claim_unavailable");
    try {
      const result = await this.options.notifier.send({
        destination: task.notificationDestination,
        text: `🔔 Watch: ${task.label}\n${observation.summary}`,
        deliveryId: sending.id,
      });
      await this.options.deliveryStore.markDelivered(sending.id, result.externalMessageId);
    } catch {
      await this.options.deliveryStore.markFailed(sending.id, "notification_failed");
      throw new Error("notification_failed");
    }
  }

  private intervalMs(task: ScheduledTaskV1): number {
    return Math.max(SCHEDULER_MIN_INTERVAL_MS, (task.intervalSeconds ?? 60) * 1_000);
  }
}

