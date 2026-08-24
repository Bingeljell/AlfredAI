import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { FileExistsProbe } from "../../src/scheduler/probes/fileExistsProbe.js";
import { HerdrAgentProbe } from "../../src/scheduler/probes/herdrAgentProbe.js";
import { RunStatusProbe } from "../../src/scheduler/probes/runStatusProbe.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("run status probe distinguishes pending, terminal failure, and missing", async () => {
  const workspace = await createTempWorkspace("scheduler-probe-run");
  const store = new RunStore(workspace);
  const run = await store.createRun("session-1", "work", "running");
  const probe = new RunStatusProbe(store);
  assert.equal((await probe.probe({ type: "run_status", runId: run.runId })).status, "pending");
  await store.updateRun(run.runId, { status: "failed" });
  const failed = await probe.probe({ type: "run_status", runId: run.runId });
  assert.equal(failed.terminal, true);
  assert.equal(failed.status, "failed");
  assert.equal((await probe.probe({ type: "run_status", runId: "missing" })).status, "missing");
});

test("file probe is workspace-scoped and reports meaningful changes", async () => {
  const workspace = await createTempWorkspace("scheduler-probe-file");
  const probe = new FileExistsProbe(workspace);
  const missing = await probe.probe({ type: "file_exists", relativePath: "result.txt" });
  assert.equal(missing.status, "missing");
  await writeFile(`${workspace}/result.txt`, "done");
  const exists = await probe.probe({ type: "file_exists", relativePath: "result.txt" }, missing.digest);
  assert.equal(exists.status, "completed");
  assert.equal(exists.changed, true);
  assert.equal((await probe.probe({ type: "file_exists", relativePath: "../outside.txt" })).status, "failed");
  await unlink(`${workspace}/result.txt`);
});

test("Herdr probe is read-only, typed, and detects terminal states", async () => {
  let output = "still working";
  const probe = new HerdrAgentProbe({
    async getAgentStatus() { return { status: "working" }; },
    async readPane() { return output; }
  });
  const running = await probe.probe({ type: "herdr_agent", workspaceId: "w1", paneId: "p1" }, undefined, "task-1");
  assert.equal(running.status, "pending");
  assert.equal(running.terminal, false);
  assert.equal(running.snapshot?.taskId, "task-1");

  output = "still working with more output";
  const stillRunning = await probe.probe({ type: "herdr_agent", workspaceId: "w1", paneId: "p1" }, running.digest, "task-1");
  assert.equal(stillRunning.changed, false);

  output = "finished\nTASK_COMPLETE";
  const result = await probe.probe({ type: "herdr_agent", workspaceId: "w1", paneId: "p1" }, running.digest, "task-1");
  assert.equal(result.status, "completed");
  assert.equal(result.terminal, true);
  assert.equal(result.changed, true);
  assert.equal(result.snapshot?.status, "TASK_COMPLETE");
});
