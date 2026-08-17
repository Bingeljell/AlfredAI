import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerDeliveryStore } from "../../src/scheduler/deliveryStore.js";
import { SchedulerEngine } from "../../src/scheduler/engine.js";
import { SchedulerTaskRunLog } from "../../src/scheduler/taskRunLog.js";
import { SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("scheduler provenance cannot create nested tasks and owner is server-derived", async () => {
  const workspace = await createTempWorkspace("scheduler-security");
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, instanceId: "security-task" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, instanceId: "security-delivery" });
  await taskStore.init();
  await deliveryStore.init();
  const engine = new SchedulerEngine({ taskStore, deliveryStore, taskRunLog: new SchedulerTaskRunLog(workspace) });
  await assert.rejects(() => engine.schedule({
    kind: "wake_turn",
    label: "nested",
    dueAt: new Date(Date.now() + 10_000).toISOString(),
    instruction: "nested",
  }, { principalId: "scheduler", origin: "scheduler" }, "session-1", "run-1"), /scheduler_cannot_schedule_tasks/);
  const task = await engine.schedule({
    kind: "wake_turn",
    label: "owned",
    dueAt: new Date(Date.now() + 10_000).toISOString(),
    instruction: "owned",
  }, { principalId: "principal-1", channelKey: "web:session-1", origin: "web" }, "session-1", "run-1");
  assert.equal(task.owner.principalId, "principal-1");
  assert.equal(task.owner.sessionId, "session-1");
  assert.equal(task.notificationDestination?.channelKey, "web:session-1");
});

