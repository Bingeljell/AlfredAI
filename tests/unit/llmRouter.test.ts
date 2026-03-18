import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { runStructuredWithFallback, runTextWithFallback } from "../../src/services/llm/router.js";
import type { LlmProvider, LlmStructuredRequest, LlmTextRequest } from "../../src/services/llm/types.js";

class FakeProvider implements LlmProvider {
  readonly name: string;
  private readonly structuredImpl: (request: LlmStructuredRequest) => Promise<Record<string, unknown>>;
  private readonly textImpl: (request: LlmTextRequest) => Promise<Record<string, unknown>>;

  constructor(args: {
    name: string;
    structuredImpl?: (request: LlmStructuredRequest) => Promise<Record<string, unknown>>;
    textImpl?: (request: LlmTextRequest) => Promise<Record<string, unknown>>;
  }) {
    this.name = args.name;
    this.structuredImpl = args.structuredImpl ?? (async () => ({ provider: this.name, result: { ok: true } }));
    this.textImpl = args.textImpl ?? (async () => ({ provider: this.name, content: "ok" }));
  }

  async generateStructured<T>(request: LlmStructuredRequest, _validator: z.ZodType<T>) {
    return this.structuredImpl(request) as Promise<{
      provider: string;
      result?: T;
      failureCode?: string;
      failureClass?: "network" | "timeout" | "schema" | "policy_block" | "unknown";
      failureMessage?: string;
      attempts?: number;
    }>;
  }

  async generateText(request: LlmTextRequest) {
    return this.textImpl(request) as Promise<{
      provider: string;
      content?: string;
      failureCode?: string;
      failureClass?: "network" | "timeout" | "schema" | "policy_block" | "unknown";
      failureMessage?: string;
      attempts?: number;
    }>;
  }

  async generateWithTools(): Promise<never> {
    throw new Error("generateWithTools not implemented in FakeProvider");
  }
}

test("runStructuredWithFallback fails over to second provider on network timeout", async () => {
  const timeoutProvider = new FakeProvider({
    name: "first",
    structuredImpl: async () => ({
      provider: "first",
      failureCode: "network_error",
      failureClass: "timeout",
      failureMessage: "The operation was aborted due to timeout"
    })
  });
  const successProvider = new FakeProvider({
    name: "second",
    structuredImpl: async () => ({
      provider: "second",
      result: { title: "ok" }
    })
  });
  const schema = z.object({ title: z.string() });
  const result = await runStructuredWithFallback({
    providers: [timeoutProvider, successProvider],
    request: {
      schemaName: "test_schema",
      jsonSchema: {
        type: "object",
        properties: {
          title: { type: "string" }
        },
        required: ["title"]
      },
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" }
      ]
    },
    validator: schema
  });

  assert.equal(result.result?.title, "ok");
  assert.equal(result.providerUsed, "second");
  assert.equal(result.providerAttempts.length, 2);
  assert.equal(result.providerAttempts[0]?.success, false);
  assert.equal(result.providerAttempts[1]?.success, true);
});

test("runStructuredWithFallback returns policy block when no providers are configured", async () => {
  const result = await runStructuredWithFallback({
    providers: [],
    request: {
      schemaName: "empty",
      jsonSchema: { type: "object", properties: {}, required: [] },
      messages: [{ role: "user", content: "test" }]
    },
    validator: z.object({})
  });

  assert.equal(result.failureCode, "missing_provider");
  assert.equal(result.failureClass, "policy_block");
  assert.equal(result.providerAttempts.length, 0);
});

test("runTextWithFallback respects preferred provider ordering", async () => {
  const first = new FakeProvider({
    name: "first",
    textImpl: async () => ({
      provider: "first",
      failureCode: "network_error",
      failureClass: "network",
      failureMessage: "upstream network issue"
    })
  });
  const second = new FakeProvider({
    name: "second",
    textImpl: async () => ({
      provider: "second",
      content: "fallback response"
    })
  });

  const result = await runTextWithFallback({
    providers: [first, second],
    preferredProvider: "second",
    request: {
      messages: [{ role: "user", content: "hello" }]
    }
  });

  assert.equal(result.content, "fallback response");
  assert.equal(result.providerUsed, "second");
  assert.equal(result.providerAttempts.length, 1);
  assert.equal(result.providerAttempts[0]?.provider, "second");
});
