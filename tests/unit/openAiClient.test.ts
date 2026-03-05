import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { runOpenAiStructuredChatWithDiagnostics } from "../../src/services/openAiClient.js";

const SimpleSchema = z.object({
  ok: z.boolean()
});

test("captures structured OpenAI http error details from JSON payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "Rate limit reached for requests",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
          param: "model"
        }
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test_123",
          "retry-after": "2",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-remaining-tokens": "1024"
        }
      }
    );

  try {
    const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
      {
        apiKey: "test-key",
        schemaName: "simple_schema",
        jsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false
        },
        messages: [{ role: "user", content: "hello" }]
      },
      SimpleSchema
    );

    assert.equal(diagnostic.failureCode, "http_error");
    assert.equal(diagnostic.statusCode, 429);
    assert.equal(diagnostic.httpErrorDetails?.statusCode, 429);
    assert.equal(diagnostic.httpErrorDetails?.errorType, "rate_limit_error");
    assert.equal(diagnostic.httpErrorDetails?.errorCode, "rate_limit_exceeded");
    assert.equal(diagnostic.httpErrorDetails?.requestId, "req_test_123");
    assert.equal(diagnostic.httpErrorDetails?.retryAfter, "2");
    assert.match(diagnostic.failureMessage ?? "", /rate_limit_error/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("captures body snippet when OpenAI http error is non-json", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream overloaded", { status: 429 });

  try {
    const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
      {
        apiKey: "test-key",
        schemaName: "simple_schema",
        jsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false
        },
        messages: [{ role: "user", content: "hello" }]
      },
      SimpleSchema
    );

    assert.equal(diagnostic.failureCode, "http_error");
    assert.equal(diagnostic.statusCode, 429);
    assert.equal(diagnostic.httpErrorDetails?.bodySnippet, "upstream overloaded");
    assert.match(diagnostic.failureMessage ?? "", /upstream overloaded/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("captures usage metadata from structured OpenAI responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ ok: true })
            }
          }
        ],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168
        }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );

  try {
    const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
      {
        apiKey: "test-key",
        schemaName: "simple_schema",
        jsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false
        },
        messages: [{ role: "user", content: "hello" }]
      },
      SimpleSchema
    );

    assert.deepEqual(diagnostic.result, { ok: true });
    assert.deepEqual(diagnostic.usage, {
      promptTokens: 123,
      completionTokens: 45,
      totalTokens: 168
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
