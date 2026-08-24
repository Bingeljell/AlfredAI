import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHerdrTerminalSnapshot,
  detectHerdrStatus,
  HERDR_SNAPSHOT_LINE_LIMIT,
  tailStdout,
} from "../../src/scheduler/probes/herdrTerminalWatcher.js";

test("Herdr watcher keeps the bounded tail and detects task completion", () => {
  const output = Array.from({ length: HERDR_SNAPSHOT_LINE_LIMIT + 5 }, (_, index) => `line-${index}`).join("\n");
  const snapshot = buildHerdrTerminalSnapshot(
    "task-1",
    { status: "working" },
    `${output}\nTASK_COMPLETE\n`,
  );

  assert.equal(snapshot.taskId, "task-1");
  assert.equal(snapshot.status, "TASK_COMPLETE");
  assert.equal(snapshot.exitCode, null);
  assert.equal(snapshot.stdout.length, HERDR_SNAPSHOT_LINE_LIMIT);
  assert.deepEqual(snapshot.stdout.slice(-2), ["line-19", "TASK_COMPLETE"]);
});

test("Herdr watcher distinguishes waiting input and non-zero exits deterministically", () => {
  assert.equal(
    detectHerdrStatus({ lifecycle: "idle", exitCode: null, stdout: "IDLE_WAITING_INPUT" }),
    "IDLE_WAITING_INPUT",
  );
  assert.equal(
    detectHerdrStatus({ lifecycle: "working", exitCode: 17, stdout: "last output" }),
    "ERROR",
  );
  assert.equal(
    detectHerdrStatus({ lifecycle: "working", exitCode: null, stdout: "still processing" }),
    "RUNNING",
  );
  assert.equal(
    detectHerdrStatus({ lifecycle: "missing", exitCode: null, stdout: "" }),
    "ERROR",
  );
});

test("tailStdout strips terminal escape sequences and removes trailing blank rows", () => {
  assert.deepEqual(tailStdout("one\n\u001b[32mtwo\u001b[0m\n\n", 15), ["one", "two"]);
});
