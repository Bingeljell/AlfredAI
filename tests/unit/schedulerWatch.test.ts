import test from "node:test";
import assert from "node:assert/strict";
import { SchedulerDeliveryStore } from "../../src/scheduler/deliveryStore.js";
import { WatchExecutor } from "../../src/scheduler/watch.js";
import type { OutboundNotifier } from "../../src/scheduler/notifier.js";
import type { ProbeResult } from "../../src/scheduler/probes/types.js";
import { SchedulerTaskRunLog } from "../../src/scheduler/taskRunLog.js";
import { SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

const pendingResult: ProbeResult = {
  status: "pending",
  digest: "digest-1",
  summary: "Still running",
  terminal: false,
  changed: false,
};

test("unchanged nonterminal watches reschedule without an LLM or notification", async () => {
  const workspace = await createTempWorkspace("scheduler-watch");
  let now = Date.parse("2026-08-17T10:00:10.000Z");
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "watch-task" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "watch-delivery" });
  await taskStore.init();
  await deliveryStore.init();
  const task = await taskStore.create({
    kind: "watch",
    label: "run",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    dueAt: "2026-08-17T10:00:20.000Z",
    intervalSeconds: 60,
    watch: { type: "run_status", runId: "run-1" },
    notificationDestination: { channelKey: "web:session-1", principalId: "principal-1" },
  });
  now += 10_000;
  const claim = await taskStore.claim(task.id, task.updatedAt);
  assert.equal(claim.claimed, true);
  if (!claim.claimed) return;
  await taskStore.markRunning(task.id, claim.cycleId);
  let notified = false;
  const notifier: OutboundNotifier = { async send() { notified = true; return { delivered: true }; } };
  const executor = new WatchExecutor({ taskStore, deliveryStore, notifier, nowMs: () => now, probe: async () => pendingResult });
  const result = await executor.execute(claim.task, claim.cycleId);
  assert.equal(result.status, "pending");
  assert.equal(result.lastObservationDigest, "digest-1");
  assert.equal(notified, false);
  assert.equal(result.cycleCount, 1);
});

test("a Herdr terminal transition feeds its structured snapshot into the wake turn", async () => {
  const workspace = await createTempWorkspace("scheduler-watch-herdr-wake");
  let now = Date.parse("2026-08-17T10:00:10.000Z");
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "herdr-watch-task" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "herdr-watch-delivery" });
  await taskStore.init();
  await deliveryStore.init();
  const task = await taskStore.create({
    kind: "watch",
    label: "herdr",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    dueAt: "2026-08-17T10:00:20.000Z",
    instruction: "Summarize the delegated task.",
    watch: { type: "herdr_agent", workspaceId: "w1", paneId: "w1:p1" },
  });
  now += 10_000;
  const claim = await taskStore.claim(task.id, task.updatedAt);
  assert.equal(claim.claimed, true);
  if (!claim.claimed) return;
  await taskStore.markRunning(task.id, claim.cycleId);

  let receivedSnapshot: unknown;
  const executor = new WatchExecutor({
    taskStore,
    deliveryStore,
    notifier: { async send() { return { delivered: true }; } },
    probe: async () => ({
      status: "completed" as const,
      digest: "terminal-digest",
      summary: "The Herdr task completed.",
      terminal: true,
      changed: true,
      snapshot: {
        taskId: task.id,
        status: "TASK_COMPLETE" as const,
        exitCode: 0,
        stdout: ["tests passed", "TASK_COMPLETE"],
      },
    }),
    executeWake: async (wakeTask, cycleId, snapshot) => {
      receivedSnapshot = snapshot;
      return taskStore.completeCycle({ taskId: wakeTask.id, cycleId, observationDigest: "terminal-digest" });
    },
    nowMs: () => now,
  });

  const result = await executor.execute({ ...claim.task, lastObservationStatus: "RUNNING" }, claim.cycleId);
  assert.deepEqual(receivedSnapshot, {
    taskId: task.id,
    status: "TASK_COMPLETE",
    exitCode: 0,
    stdout: ["tests passed", "TASK_COMPLETE"],
  });
  assert.equal(result.status, "completed");
});

test("an initial Herdr idle snapshot establishes a baseline instead of completing the watch", async () => {
  const workspace = await createTempWorkspace("scheduler-watch-herdr-baseline");
  let now = Date.parse("2026-08-17T10:00:10.000Z");
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "herdr-baseline-task" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "herdr-baseline-delivery" });
  await taskStore.init();
  await deliveryStore.init();
  const task = await taskStore.create({
    kind: "watch",
    label: "herdr baseline",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    dueAt: "2026-08-17T10:00:20.000Z",
    intervalSeconds: 60,
    instruction: "Summarize the delegated task.",
    watch: { type: "herdr_agent", workspaceId: "w1", paneId: "w1:p1" },
  });
  now += 10_000;
  const claim = await taskStore.claim(task.id, task.updatedAt);
  assert.equal(claim.claimed, true);
  if (!claim.claimed) return;
  await taskStore.markRunning(task.id, claim.cycleId);

  let wakeCalled = false;
  let notified = false;
  const executor = new WatchExecutor({
    taskStore,
    deliveryStore,
    notifier: { async send() { notified = true; return { delivered: true }; } },
    probe: async () => ({
      status: "completed" as const,
      digest: "idle-digest",
      summary: "The Herdr agent is idle and waiting for input.",
      terminal: true,
      changed: false,
      snapshot: {
        taskId: task.id,
        status: "IDLE_WAITING_INPUT" as const,
        exitCode: null,
        stdout: ["IDLE_WAITING_INPUT"],
      },
    }),
    executeWake: async () => {
      wakeCalled = true;
      throw new Error("wake should not run for the initial idle baseline");
    },
    nowMs: () => now,
  });

  const result = await executor.execute(claim.task, claim.cycleId);
  assert.equal(result.status, "pending");
  assert.equal(result.lastObservationStatus, "IDLE_WAITING_INPUT");
  assert.equal((await taskStore.get(task.id))?.lastObservationStatus, "IDLE_WAITING_INPUT");
  assert.equal(wakeCalled, false);
  assert.equal(notified, false);
});
