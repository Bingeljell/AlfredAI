import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexRequestBody,
  buildStablePromptCacheKey,
  toResponsesInput,
  toResponsesTools
} from "../../src/provider/codex/messages.js";

test("Codex messages combine ordered system prompts and translate Responses items", () => {
  const translated = toResponsesInput([
    { role: "system", content: "identity" },
    { role: "system", content: "rules" },
    { role: "user", content: "find it" },
    { role: "assistant", content: null, toolCalls: [{ id: "call-1", name: "search", arguments: "{\"q\":\"x\"}" }] },
    { role: "tool", toolCallId: "call-1", toolName: "search", content: "result" }
  ]);

  assert.equal(translated.instructions, "identity\n\nrules");
  assert.deepEqual(translated.input, [
    { role: "user", content: [{ type: "input_text", text: "find it" }] },
    { type: "function_call", call_id: "call-1", name: "search", arguments: "{\"q\":\"x\"}" },
    { type: "function_call_output", call_id: "call-1", output: "result" }
  ]);
});

test("Codex provider state replays raw items and ignores other providers", () => {
  const raw = { type: "reasoning", encrypted_content: "opaque" };
  const translated = toResponsesInput([
    { role: "assistant", content: "ignored", toolCalls: [{ id: "duplicate", name: "bad", arguments: "{}" }], providerState: { provider: "codex", data: { outputItems: [raw] } } },
    { role: "assistant", content: "text", providerState: { provider: "gemini", data: ["parts"] } }
  ]);
  assert.deepEqual(translated.input, [raw, { role: "assistant", content: [{ type: "output_text", text: "text" }] }]);
});

test("Codex body uses the Responses tool shape and hashed cache key", () => {
  const body = buildCodexRequestBody({
    model: "codex-mini",
    sessionId: "session-secret",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    tools: [{ name: "search", description: "Search", parameters: { type: "object" } }]
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.prompt_cache_key, buildStablePromptCacheKey("session-secret"));
  assert.deepEqual(body.tools, [{ type: "function", name: "search", description: "Search", parameters: { type: "object" }, strict: null }]);
  assert.equal(JSON.stringify(body).includes("session-secret"), false);
});
