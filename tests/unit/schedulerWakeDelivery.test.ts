import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerEngine } from "../../src/scheduler/engine.js";
import type { SchedulerClock } from "../../src/scheduler/clock.js";
import { SchedulerDeliveryStore } from "../../src/scheduler/deliveryStore.js";
import { SchedulerTaskRunLog } from "../../src/scheduler/taskRunLog.js";
import { SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import type { OutboundNotification, OutboundNotifier } from "../../src/scheduler/notifier.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class FakeClock implements SchedulerClock {
  now = Date.parse("2026-08-24T10:00:00.000Z");

  nowMs(): number { return this.now; }
  setTimeout(_callback: () => void): ReturnType<typeof setTimeout> { return 1 as unknown as ReturnType<typeof setTimeout>; }
  clearTimeout(): void {}
}

class CapturingNotifier implements OutboundNotifier {
  notifications: OutboundNotification[] = [];

  async send(notification: OutboundNotification) {
    this.notifications.push(notification);
    return { delivered: true, externalMessageId: "external-1" };
  }
}

test("scheduler wake explanation is delivered through the durable delivery ledger", async () => {
  const workspace = await createTempWorkspace("scheduler-wake-delivery");
  const clock = new FakeClock();
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => clock.nowMs(), instanceId: "wake-delivery-task" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => clock.nowMs(), instanceId: "wake-delivery-ledger" });
  const notifier = new CapturingNotifier();
  const engine = new SchedulerEngine({
    taskStore,
    deliveryStore,
    taskRunLog: new SchedulerTaskRunLog(workspace),
    notifier,
    clock,
    executeWake: async (task, cycleId) => {
      const completed = await taskStore.completeCycle({
        taskId: task.id,
        cycleId,
        completionSummary: "Wake completed with a bounded explanation",
      });
      return { ...completed, assistantText: "The wake checked the task and completed it." };
    },
  });

  await taskStore.init();
  await deliveryStore.init();
  const task = await taskStore.create({
    kind: "wake_turn",
    label: "bounded wake",
    owner: { sessionId: "session-1", principalId: "principal-1", channelKey: "web:session-1" },
    createdByRunId: "run-1",
    dueAt: new Date(clock.now + 5_000).toISOString(),
    instruction: "Check the task",
    notificationDestination: { channelKey: "web:session-1", principalId: "principal-1" },
  });

  await engine.start();
  clock.now += 5_000;
  await engine.tick();
  await engine.stop();

  assert.equal(notifier.notifications.length, 1);
  assert.equal(notifier.notifications[0]?.text, "The wake checked the task and completed it.");
  assert.equal(notifier.notifications[0]?.deliveryId, `${task.id}:${task.id}:1:wake_explanation`);
  const delivery = await deliveryStore.get(`${task.id}:${task.id}:1:wake_explanation`);
  assert.equal(delivery?.status, "delivered");
  assert.equal(delivery?.externalMessageId, "external-1");
  assert.equal((await taskStore.get(task.id))?.status, "completed");
});
