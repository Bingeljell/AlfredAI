import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { accumulateCodexEvents, parseCodexSseText, parseSseEvents } from "../../src/provider/codex/sse.js";

const fixture = (name: string) => readFile(path.join(process.cwd(), "tests/fixtures/codex", name), "utf8");

test("Codex SSE parses arbitrary byte boundaries, comments, CRLF, and usage", async () => {
  const text = (await fixture("text-response.sse")).replaceAll("\n", "\r\n");
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    for (let index = 0; index < bytes.length; index += 1) yield bytes.slice(index, index + 1);
  }
  const events = [];
  for await (const event of parseSseEvents(chunks())) events.push(event);
  const parsed = accumulateCodexEvents(events);
  assert.equal(parsed.content, "Hello from Codex.");
  assert.deepEqual(parsed.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7, cachedTokens: 1 });
  assert.equal(parsed.terminalEvent, "response.done");
});

test("Codex SSE preserves parallel/interleaved tool calls and raw output items", async () => {
  const parsed = await parseCodexSseText(await fixture("tool-call-response.sse"));
  assert.deepEqual(parsed.toolCalls, [{ id: "call_1", name: "search", arguments: "{\"query\":\"Alfred\"}" }]);
  assert.equal((parsed.providerState?.data as any).outputItems[0].call_id, "call_1");
});

test("Codex SSE maps incomplete and failed terminal events safely", async () => {
  const incomplete = await parseCodexSseText(await fixture("incomplete-response.sse"));
  assert.equal(incomplete.failureCode, "length");
  const failed = await parseCodexSseText(await fixture("failed-response.sse"));
  assert.equal(failed.failureCode, "provider_error");
  assert.equal(failed.failureMessage?.includes("server_error"), false);
});

test("Codex SSE rejects malformed data without echoing the frame", async () => {
  await assert.rejects(
    () => parseCodexSseText("data: {\"secret\":\"canary\"}\ndata: not-json\n\n"),
    (error: unknown) => error instanceof Error && error.message === "Codex response contained invalid event data" && !error.message.includes("canary")
  );
});
