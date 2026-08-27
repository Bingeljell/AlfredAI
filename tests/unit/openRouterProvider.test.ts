import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterLlmProvider } from "../../src/provider/openrouter.js";

test("OpenRouter provider forwards reasoning, session id, and captures bounded routing metadata", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      id: "gen-test-1",
      model: "minimax/minimax-m3",
      service_tier: "priority",
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 12 }
      },
      openrouter_metadata: {
        strategy: "free",
        region: "iad",
        attempt: 2,
        endpoints: {
          available: [
            { provider: "ExampleProvider", model: "minimax/minimax-m3", selected: true }
          ]
        }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const provider = new OpenRouterLlmProvider({
      apiKey: "test-key",
      defaultModel: "minimax/minimax-m3:free",
      reasoning: { effort: "high", exclude: true }
    });
    const result = await provider.generateWithTools({
      sessionId: "session-123",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    });

    assert.deepEqual(capturedBody?.reasoning, { effort: "high", exclude: true });
    assert.deepEqual(capturedBody?.provider, { require_parameters: true });
    assert.equal(capturedBody?.session_id, "session-123");
    assert.equal(capturedHeaders?.get("x-openrouter-metadata"), "enabled");
    assert.equal(result.usage?.cachedTokens, 80);
    assert.equal(result.usage?.reasoningTokens, 12);
    assert.deepEqual(result.providerMetadata, {
      responseId: "gen-test-1",
      responseModel: "minimax/minimax-m3",
      serviceTier: "priority",
      upstreamProvider: "ExampleProvider",
      routingStrategy: "free",
      routingAttempt: 2,
      region: "iad"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter provider leaves reasoning unset in model-default mode", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const provider = new OpenRouterLlmProvider({ apiKey: "test-key" });
    await provider.generateWithTools({ messages: [{ role: "user", content: "hello" }], tools: [] });
    assert.equal(Object.prototype.hasOwnProperty.call(capturedBody ?? {}, "reasoning"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
