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

