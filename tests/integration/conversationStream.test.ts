import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { conversationStream } from "../../src/gateway/conversationStream.js";
import { SessionStore } from "../../src/memory/sessionStore.js";
import { RunStore } from "../../src/runs/runStore.js";
import { FileWebActivitySink, RoutingOutboundNotifier, WebOutboundNotifier } from "../../src/scheduler/notifier.js";
import { readSnapshots } from "../../src/tui/client.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { ConversationSnapshot } from "../../src/types.js";

test("conversation stream reconciles shared runs on reconnect and scopes notifications", async () => {
  const workspace = await createTempWorkspace("tui-stream");
  const sessions = new SessionStore(workspace);
  const runs = new RunStore(workspace);
  const activity = new FileWebActivitySink(workspace);
  const notifier = new RoutingOutboundNotifier(new WebOutboundNotifier(activity));
  const session = await sessions.createSession("Telegram research");
  const run = await runs.createRun(session.id, "Started in Telegram", "running");
  const app = new Hono();
  app.get("/sessions/:sessionId/stream", (c) => conversationStream(c, sessions, runs, activity));

  async function readOnce(previous?: ConversationSnapshot) {
    const response = await app.request(`/sessions/${session.id}/stream`, { headers: previous ? { "Last-Event-ID": String(previous.cursor) } : {} });
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const iterator = readSnapshots(response.body!, new AbortController().signal, previous);
    try {
      const next = await iterator.next();
      if (next.done) throw new Error("Missing snapshot");
      return next.value;
    }
    finally { await iterator.return(undefined); }
  }

  const initial = await readOnce();
  assert.equal(initial.runs[0]?.status, "running");
  // Closing a stream must not request cancellation.
  assert.equal((await runs.getRun(run.runId))?.cancelRequestedAt, undefined);
  await runs.updateRun(run.runId, { status: "completed", assistantText: "Ready to continue", artifactPaths: ["report.md"] });
  await notifier.send({ destination: { principalId: "api", channelKey: `tui:${session.id}` }, text: "Reminder", deliveryId: "delivery-1" });
  await activity.append({ principalId: "someone-else", channelKey: `tui:${session.id}`, text: "Private", deliveryId: "delivery-2" });
  const replayed = await readOnce(initial);
  assert.equal(replayed.runs.length, 1);
  assert.equal(replayed.runs[0]?.status, "completed");
  assert.ok(replayed.cursor! > initial.cursor!);
  const resumed = await readOnce();
  assert.equal(resumed.session.id, session.id);
  assert.equal(resumed.runs[0]?.assistantText, "Ready to continue");
  assert.deepEqual(resumed.runs[0]?.artifactPaths, ["report.md"]);
  assert.deepEqual(resumed.notifications.map((item) => item.text), ["Reminder"]);
  assert.equal((await app.request("/sessions/missing/stream")).status, 404);
});
