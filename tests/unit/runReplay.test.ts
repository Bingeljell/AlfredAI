import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import { GatewayClient } from "../../src/tui/client.js";

test("run replay cursors survive store restart and detect retention gaps", { timeout: 20_000 }, async () => {
  const workspace = await createTempWorkspace("run-replay");
  const store = new RunStore(workspace);
  const run = await store.createRun("session", "hello", "running");
  const initial = await store.changesSince("session", 0);
  await store.updateRun(run.runId, { assistantPreview: "First words" });
  const restarted = new RunStore(workspace);
  const replay = await restarted.changesSince("session", initial.cursor);
  assert.equal(replay.reset, false);
  assert.deepEqual(replay.changes.map((change) => change.runId), [run.runId]);
  for (let i = 0; i < 513; i++) await store.updateRun(run.runId, { assistantPreview: `words ${i}` });
  const expired = await restarted.changesSince("session", initial.cursor);
  assert.equal(expired.reset, true);
  assert.equal(expired.changes.length, 512);
  assert.equal((await restarted.changesSince("session", expired.cursor)).changes.length, 0);
});

test("client reconnect sends its cursor and replaces cumulative run state without duplication", async () => {
  const session = { id: "s", name: "Shared", status: "active", createdAt: "now", updatedAt: "now" };
  const run = { runId: "r", sessionId: "s", message: "hello", status: "running", createdAt: "now", updatedAt: "now", toolCalls: [], assistantPreview: "First" };
  const headers: Headers[] = [];
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    headers.push(new Headers(init.headers));
    return new Response(headers.length === 1
      ? `event: snapshot\nid: 1\ndata: ${JSON.stringify({ session, runs: [run], notifications: [] })}\n\n`
      : `event: run\nid: 2\ndata: ${JSON.stringify({ run: { ...run, assistantPreview: "First words" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const client = new GatewayClient("http://localhost", "key", fetcher);
  for await (const _snapshot of client.watch("s", new AbortController().signal)) { /* seed reconnect cache */ }
  for await (const snapshot of client.watch("s", new AbortController().signal)) {
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0]?.assistantPreview, "First words");
  }
  assert.equal(headers[1]?.get("last-event-id"), "1");
});
