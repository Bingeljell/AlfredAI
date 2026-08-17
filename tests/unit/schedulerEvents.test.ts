import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerDeliveryStore } from "../../src/scheduler/deliveryStore.js";
import { SchedulerEngine } from "../../src/scheduler/engine.js";
import { SchedulerTaskRunLog } from "../../src/scheduler/taskRunLog.js";
import { SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("matching agent events nudge one logical subscription to due", async () => {
  const workspace = await createTempWorkspace("scheduler-events");
  let now = Date.parse("2026-08-17T10:00:00.000Z");
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "event-task" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "event-delivery" });
  await taskStore.init();
  await deliveryStore.init();
  const task = await taskStore.create({
    kind: "event_subscription",
    label: "deployment events",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    dueAt: "2026-08-17T10:00:10.000Z",
    eventMatch: { workspaceId: "w1", paneId: "p1", eventTypes: ["completed"] },
  });
  const engine = new SchedulerEngine({
    taskStore,
    deliveryStore,
    taskRunLog: new SchedulerTaskRunLog(workspace),
    tickMaxMs: 15_000,
    clock: {
      nowMs: () => now,
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => {},
    },
  });
  now += 1_000;
  await engine.handleAgentEvent({ workspaceId: "w1", paneId: "p1", agentKind: "codex", source: "herdr", eventType: "completed" });
  const nudged = await taskStore.get(task.id);
  assert.equal(nudged?.dueAt, new Date(now).toISOString());
  await engine.handleAgentEvent({ workspaceId: "other", paneId: "p1", agentKind: "codex", source: "herdr", eventType: "completed" });
  assert.equal((await taskStore.get(task.id))?.dueAt, new Date(now).toISOString());
});
