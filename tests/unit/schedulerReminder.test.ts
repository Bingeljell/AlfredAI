import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerDeliveryStore } from "../../src/scheduler/deliveryStore.js";
import { ReminderExecutor } from "../../src/scheduler/reminder.js";
import type { OutboundNotification, OutboundNotifier } from "../../src/scheduler/notifier.js";
import { SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class FakeNotifier implements OutboundNotifier {
  calls: OutboundNotification[] = [];
  failuresRemaining: number;

  constructor(failuresRemaining = 0) {
    this.failuresRemaining = failuresRemaining;
  }

  async send(notification: OutboundNotification): Promise<{ delivered: boolean; externalMessageId?: string }> {
    this.calls.push(notification);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("temporary delivery failure");
    }
    return { delivered: true, externalMessageId: "message-1" };
  }
}

test("reminders use one delivery ID and retry without incrementing the cycle", async () => {
  const workspace = await createTempWorkspace("scheduler-reminder");
  let now = Date.parse("2026-08-17T10:00:00.000Z");
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "scheduler-reminder" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "delivery-reminder" });
  await taskStore.init();
  await deliveryStore.init();
  const task = await taskStore.create({
    kind: "reminder",
    label: "standup",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    dueAt: "2026-08-17T10:00:10.000Z",
    reminderText: "Standup starts now",
    notificationDestination: { channelKey: "web:session-1", principalId: "principal-1" },
  });
  now += 10_000;
  const claim = await taskStore.claim(task.id, task.updatedAt);
  assert.equal(claim.claimed, true);
  if (!claim.claimed) return;
  await taskStore.markRunning(task.id, claim.cycleId);
  const notifier = new FakeNotifier(1);
  const completed = await new ReminderExecutor({ taskStore, deliveryStore, notifier, retryDelayMs: 0 }).execute(claim.task, claim.cycleId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.cycleCount, 1);
  assert.equal(notifier.calls.length, 2);
  assert.equal(notifier.calls[0]?.deliveryId, notifier.calls[1]?.deliveryId);
  assert.equal(notifier.calls[1]?.text, "⏰ Reminder: Standup starts now");
});
