import test from "node:test";
import assert from "node:assert/strict";
import { GatewayClient, readSnapshots } from "../../src/tui/client.js";
import { Composer, cellWidth, graphemes, plain, transcript, wrap } from "../../src/tui/screen.js";
import { parseTuiArgs } from "../../src/tui/index.js";
import type { ConversationSnapshot, RunRecord } from "../../src/types.js";

const snapshot: ConversationSnapshot = {
  session: { id: "telegram-session", name: "Research 東京", createdAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-05T12:00:00Z", status: "active" },
  runs: [], notifications: []
};

test("SSE decoding survives split UTF-8, CRLF, heartbeats, and multiple snapshots", async () => {
  const bytes = new TextEncoder().encode(`event: heartbeat\r\ndata: {}\r\n\r\nevent: snapshot\r\ndata: ${JSON.stringify(snapshot)}\r\n\r\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const received = [];
  for await (const value of readSnapshots(body, new AbortController().signal)) received.push(value);
  assert.deepEqual(received, [snapshot, snapshot]);
});

test("aborting a conversation stream cancels its reader", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  const iterator = readSnapshots(body, controller.signal);
  const next = iterator.next();
  controller.abort();
  assert.equal((await next).done, true);
  assert.equal(cancelled, true);
});

test("terminal submits to the same session with TUI provenance and never retries ambiguous POSTs", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new GatewayClient("http://localhost:3000", "test-key", (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    throw new Error("socket lost after acceptance");
  }) as typeof fetch);
  await assert.rejects(client.submit("telegram-session", "Continue", new AbortController().signal), /socket lost/);
  assert.equal(requests.length, 1);
  const { requestId, ...payload } = JSON.parse(String(requests[0]!.init.body));
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(payload, { sessionId: "telegram-session", message: "Continue", requestJob: true, surface: "tui" });
  await assert.rejects(client.submit("telegram-session", "Continue", new AbortController().signal));
  assert.equal(JSON.parse(String(requests[1]!.init.body)).requestId, requestId);
  assert.equal(new Headers(requests[0]!.init.headers).get("x-api-key"), "test-key");
  assert.equal(requests[0]!.init.redirect, "error");
});

test("terminal authentication errors are actionable without exposing credentials", async () => {
  const client = new GatewayClient("http://localhost:3000", "secret-value", (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch);
  await assert.rejects(client.sessions(), (error: Error) => /Authentication failed/.test(error.message) && !error.message.includes("secret-value"));
});

test("terminal treats model output as text and wraps wide graphemes within the viewport", () => {
  const hostile = "hello\x1b[2J\x1b]52;c;c2VjcmV0\x07world";
  assert.equal(plain(hostile), "helloworld");
  for (const line of wrap("東京 👩‍💻 café\nline two", 5)) {
    assert.ok(graphemes(line).reduce((sum, char) => sum + cellWidth(char), 0) <= 5);
  }
  const editor = new Composer();
  editor.insert("a👩‍💻b");
  editor.cursor = 2;
  editor.backspace();
  assert.equal(editor.value, "ab");
  editor.insert("\r\n東京");
  assert.equal(editor.value, "a\n東京b");
});

test("transcript ordering uses creation time, includes cancellation and artifacts, and sanitizes tool output", () => {
  const run = (id: string, createdAt: string): RunRecord => ({
    runId: id, sessionId: "s", message: id, status: "running", createdAt, updatedAt: createdAt,
    toolCalls: [], artifactPaths: ["workspace/alfred/report.md"], cancelRequestedAt: createdAt
  });
  const lines = transcript([run("second", "2026-09-05T12:01:00Z"), run("first", "2026-09-05T12:00:00Z")], 80, false);
  assert.ok(lines.indexOf("first") < lines.indexOf("second"));
  assert.ok(lines.includes("Cancellation requested…"));
  assert.ok(lines.some((line) => line.includes("workspace/alfred/report.md")));
});

test("TUI CLI accepts explicit session attachment and rejects incomplete options", () => {
  assert.deepEqual(parseTuiArgs(["--session", "s", "--url", "http://localhost:3000"]), { sessionId: "s", url: "http://localhost:3000" });
  assert.throws(() => parseTuiArgs(["--session"]), /requires a value/);
  assert.throws(() => parseTuiArgs(["--unknown"]), /Unknown/);
});
