import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerDeliveryStore } from "../../src/scheduler/deliveryStore.js";
import { SchedulerEngine } from "../../src/scheduler/engine.js";
import type { OutboundNotification, OutboundNotifier } from "../../src/scheduler/notifier.js";
import { ReminderExecutor } from "../../src/scheduler/reminder.js";
import { SchedulerTaskRunLog } from "../../src/scheduler/taskRunLog.js";
import { SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import type { SchedulerClock } from "../../src/scheduler/clock.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class FakeClock implements SchedulerClock {
  now = Date.parse("2026-08-17T10:00:00.000Z");
  private nextId = 1;
  private timers = new Map<number, () => void>();
  nowMs(): number { return this.now; }
  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle as unknown as number);
  }
}

class FakeNotifier implements OutboundNotifier {
  texts: string[] = [];
  async send(notification: OutboundNotification): Promise<{ delivered: boolean }> {
    this.texts.push(notification.text);
    return { delivered: true };
  }
}

test("engine recovers, claims, and executes due reminders", async () => {
  const workspace = await createTempWorkspace("scheduler-engine");
  const clock = new FakeClock();
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => clock.nowMs(), instanceId: "engine-task" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => clock.nowMs(), instanceId: "engine-delivery" });
  const notifier = new FakeNotifier();
  const reminderExecutor = new ReminderExecutor({ taskStore, deliveryStore, notifier, nowMs: () => clock.nowMs(), retryDelayMs: 0 });
  const engine = new SchedulerEngine({
    taskStore,
    deliveryStore,
    taskRunLog: new SchedulerTaskRunLog(workspace),
    reminderExecutor,
    clock,
    maxConcurrency: 1,
    tickMaxMs: 15_000,
  });
  await taskStore.init();
  await deliveryStore.init();
  const task = await taskStore.create({
    kind: "reminder",
    label: "reminder",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    dueAt: "2026-08-17T10:00:10.000Z",
    reminderText: "Time",
    notificationDestination: { channelKey: "web:session-1", principalId: "principal-1" },
  });
  await engine.start();
  clock.now += 10_000;
  await engine.tick();
  await engine.stop();
  const completed = await taskStore.get(task.id);
  assert.equal(completed?.status, "completed");
  assert.deepEqual(notifier.texts, ["⏰ Reminder: Time"]);
});

test("engine reclaims an expired lease on startup", async () => {
  const workspace = await createTempWorkspace("scheduler-engine-recovery");
  const clock = new FakeClock();
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => clock.nowMs(), instanceId: "engine-recovery" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => clock.nowMs(), instanceId: "engine-recovery-delivery" });
  await taskStore.init();
  await deliveryStore.init();
  const task = await taskStore.create({
    kind: "wake_turn",
    label: "wake",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    dueAt: "2026-08-17T10:00:10.000Z",
    instruction: "Check the work",
  });
  clock.now += 10_000;
  const claim = await taskStore.claim(task.id, task.updatedAt);
  assert.equal(claim.claimed, true);
  clock.now += 120_001;
  const engine = new SchedulerEngine({ taskStore, deliveryStore, taskRunLog: new SchedulerTaskRunLog(workspace), clock });
  await engine.start();
  const recovered = await taskStore.get(task.id);
  assert.equal(recovered?.status, "pending");
  assert.equal(recovered?.activeCycleId, undefined);
  await engine.stop();
});

