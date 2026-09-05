import test from "node:test";
import assert from "node:assert/strict";
import { conversationWindow } from "../../src/memory/conversationHistory.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { RunRecord } from "../../src/types.js";

test("canonical context keeps long recent answers, excludes active runs, and honors legacy reset boundaries", () => {
  const run = (id: string, message: string, status: RunRecord["status"] = "completed"): RunRecord => ({
    runId: id, sessionId: "session", message, assistantText: "a".repeat(5_000), status,
    createdAt: `2026-09-05T12:00:0${id}Z`, updatedAt: `2026-09-05T12:00:0${id}Z`, toolCalls: []
  });
  const runs = [run("1", "old"), run("2", "/newsession"), run("3", "recent"), run("4", "current", "running")];
  const window = conversationWindow(runs);
  assert.deepEqual(window.map((entry) => entry.runId), ["3", "3"]);
  assert.equal(window[1]?.content.length, 5_000);
  const bounded = conversationWindow(runs, 1_000);
  assert.ok(bounded.reduce((size, entry) => size + entry.content.length, 0) <= 1_000);
});

test("history pagination is session-scoped and stable when old runs are updated", async () => {
  const workspace = await createTempWorkspace("history-pagination");
  const store = new RunStore(workspace);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const run = await store.createRun("session", String(i), "completed");
    await store.updateRun(run.runId, { createdAt: `2026-09-05T12:00:0${i}Z` });
    ids.push(run.runId);
  }
  const other = await store.createRun("other", "private", "completed");
  const first = await store.listHistory("session", { limit: 2 });
  await store.updateRun(ids[0]!, { assistantText: "Changed" });
  const next = await store.listHistory("session", { before: first.nextCursor, limit: 2 });
  assert.deepEqual([...first.runs, ...next.runs].map((run) => run.runId), ids.reverse());
  assert.equal(next.nextCursor, undefined);
  await assert.rejects(store.listHistory("session", { before: other.runId }), /invalid_history_cursor/);
});
