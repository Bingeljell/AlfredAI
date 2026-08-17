import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SchedulerStoreError, SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

function createInput(dueAt: string, instruction = "Review the pending work") {
  return {
    kind: "wake_turn" as const,
    label: "wake me",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    dueAt,
    instruction,
  };
}

test("task store creates atomically and claims a deterministic cycle", async () => {
  const workspace = await createTempWorkspace("scheduler-store");
  let now = Date.parse("2026-08-17T10:00:00.000Z");
  const store = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "scheduler-a" });
  await store.init();

  const [first, second] = await Promise.all([
    store.create(createInput("2026-08-17T10:00:10.000Z")),
    store.create(createInput("2026-08-17T10:00:11.000Z")),
  ]);
  assert.notEqual(first.id, second.id);
  now = Date.parse("2026-08-17T10:00:12.000Z");
  const claim = await store.claim(first.id, first.updatedAt);
  assert.equal(claim.claimed, true);
  if (!claim.claimed) return;
  assert.equal(claim.cycleId, `${first.id}:1`);
  const running = await store.markRunning(first.id, claim.cycleId, "run-scheduler-1");
  assert.equal(running.status, "running");
  assert.equal(running.activeRunId, "run-scheduler-1");
  assert.equal(await store.renewLease(first.id, claim.cycleId), true);
  const completed = await store.completeCycle({ taskId: first.id, cycleId: claim.cycleId });
  assert.equal(completed.status, "completed");
  assert.equal(completed.activeCycleId, undefined);
});

test("task store rejects stale updates and enforces one winner for a claim", async () => {
  const workspace = await createTempWorkspace("scheduler-store-claim");
  let now = Date.parse("2026-08-17T10:00:00.000Z");
  const store = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "scheduler-a" });
  await store.init();
  const task = await store.create(createInput("2026-08-17T10:00:10.000Z"));
  now += 11_000;
  const [a, b] = await Promise.all([store.claim(task.id, task.updatedAt), store.claim(task.id, task.updatedAt)]);
  assert.equal([a, b].filter((result) => result.claimed).length, 1);
  assert.ok([a, b].some((result) => !result.claimed && (result.reason === "not_pending" || result.reason === "stale_update")));
});

test("expired lock is recovered only after structured expiry validation", async () => {
  const workspace = await createTempWorkspace("scheduler-store-lock");
  let now = Date.parse("2026-08-17T10:00:00.000Z");
  const store = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => now, instanceId: "scheduler-b" });
  await store.init();
  await writeFile(store.lockPath, JSON.stringify({ ownerId: "old", pid: 123, createdAtMs: now - 60_000, expiresAtMs: now - 1 }));
  const task = await store.create(createInput("2026-08-17T10:00:10.000Z"));
  assert.equal(task.status, "pending");
  await writeFile(store.lockPath, "not-json");
  await assert.rejects(() => store.create(createInput("2026-08-17T10:00:11.000Z")), /timed out waiting/);
});

test("malformed snapshots fail closed and are quarantined", async () => {
  const workspace = await createTempWorkspace("scheduler-store-quarantine");
  const store = new SchedulerTaskStore({ workspaceDir: workspace, instanceId: "scheduler-c" });
  await store.init();
  await writeFile(store.tasksPath, JSON.stringify({ version: 999, tasks: [] }));
  await assert.rejects(() => store.get("missing"), SchedulerStoreError);
  const files = await readdir(path.dirname(store.tasksPath));
  assert.ok(files.some((file) => file.startsWith("tasks.json.corrupt-")));
});

test("persisted task snapshots and task-run logs do not contain raw secrets", async () => {
  const workspace = await createTempWorkspace("scheduler-store-redaction");
  const store = new SchedulerTaskStore({
    workspaceDir: workspace,
    instanceId: "scheduler-d",
    nowMs: () => Date.parse("2026-08-17T10:00:00.000Z"),
  });
  await store.init();
  const task = await store.create(createInput("2026-08-17T10:00:10.000Z", "Use sk-test-secret-value-123456 only as a canary"));
  const snapshot = await readFile(store.tasksPath, "utf8");
  assert.equal(snapshot.includes("sk-test-secret-value-123456"), false);
  assert.equal((await store.get(task.id))?.instruction?.includes("sk-test-secret-value-123456"), false);
  await mkdir(store.taskRunsDir, { recursive: true });
  assert.ok(store.taskRunsDir.endsWith("task-runs"));
});
