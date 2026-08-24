import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import {
  TASK_SUMMARY_MAX_CHARS,
  TASK_TRANSCRIPT_MAX_BYTES,
  TASK_TRANSCRIPT_MAX_ENTRIES,
  TaskTranscriptStore,
} from "../../src/scheduler/taskTranscript.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("task transcripts persist coordination turns under a bounded task directory", async () => {
  const workspace = await createTempWorkspace("task-transcript");
  const store = new TaskTranscriptStore(workspace);
  const taskId = "task-1";

  await Promise.all(Array.from({ length: TASK_TRANSCRIPT_MAX_ENTRIES + 20 }, (_, index) => store.append({
    version: 1,
    taskId,
    cycleId: `cycle-${index}`,
    runId: `run-${index}`,
    event: index % 2 === 0 ? "turn_started" : "turn_completed",
    timestamp: "2026-08-24T00:00:00.000Z",
    instruction: `${"x".repeat(1_000)}-${index}`,
    status: "completed",
  })));

  const transcriptPath = store.transcriptPath(taskId);
  const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
  assert.ok(lines.length <= TASK_TRANSCRIPT_MAX_ENTRIES);
  assert.ok((await stat(transcriptPath)).size <= TASK_TRANSCRIPT_MAX_BYTES);
  assert.match(lines.at(-1) ?? "", /cycle-147/);
});

test("task summaries are bounded and reject unsafe task paths", async () => {
  const workspace = await createTempWorkspace("task-summary");
  const store = new TaskTranscriptStore(workspace);
  await store.writeSummary({
    taskId: "task-2",
    label: "bounded summary",
    status: "completed",
    cycleCount: 3,
    completedAt: "2026-08-24T00:00:00.000Z",
    summary: "summary ".repeat(2_000),
  });

  const summaryPath = store.summaryPath("task-2");
  const summary = await readFile(summaryPath, "utf8");
  assert.ok(summary.length <= TASK_SUMMARY_MAX_CHARS + 1);
  assert.match(summary, /Status: completed/);
  assert.throws(() => store.transcriptPath("../outside"), /invalid_task_id/);
});
