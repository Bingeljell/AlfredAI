import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeCodexCredentials } from "../../src/provider/codex/auth.js";
import { CodexLlmProvider } from "../../src/provider/codex/provider.js";

function token(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth.chatgpt_account_id": accountId })).toString("base64url");
  return `e30.${payload}.signature`;
}

async function withProvider<T>(sse: string, fn: (provider: CodexLlmProvider, authPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alfred-codex-provider-"));
  const authPath = path.join(dir, "auth.json");
  await writeCodexCredentials({ version: 1, provider: "codex", accessToken: token("acct-provider"), refreshToken: "refresh", expiresAtMs: Date.now() + 3_600_000, accountId: "acct-provider" }, authPath);
  const provider = new CodexLlmProvider({ authFilePath: authPath, defaultModel: "codex-mini", fetchImpl: async () => new Response(sse, { status: 200 }) });
  try {
    return await fn(provider, authPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Codex provider returns text and structured results through the same provider contract", async () => {
  await withProvider(
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\\\"ok\\\":true}\"}\n\ndata: {\"type\":\"response.done\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n",
    async (provider) => {
      const structured = await provider.generateStructured({ messages: [{ role: "user", content: "json" }], schemaName: "answer", jsonSchema: { type: "object" } }, z.object({ ok: z.boolean() }));
      assert.deepEqual(structured.result, { ok: true });
    }
  );
  await withProvider(
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.done\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n",
    async (provider) => {
      const text = await provider.generateText({ messages: [{ role: "user", content: "hello" }] });
      assert.equal(text.content, "hello");
    }
  );
});

test("Codex provider returns Alfred tool calls with opaque continuation state", async () => {
  const sse = "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"item\",\"type\":\"function_call\",\"call_id\":\"call\",\"name\":\"search\",\"arguments\":\"{}\"}}\n\ndata: {\"type\":\"response.done\",\"response\":{\"status\":\"completed\",\"output\":[{\"id\":\"item\",\"type\":\"function_call\",\"call_id\":\"call\",\"name\":\"search\",\"arguments\":\"{}\"}]}}\n\n";
  await withProvider(sse, async (provider, authPath) => {
    const result = await provider.generateWithTools({ model: "codex-mini", messages: [{ role: "user", content: "search" }], tools: [{ name: "search", description: "Search", parameters: { type: "object" } }] });
    assert.deepEqual(result.toolCalls, [{ id: "call", name: "search", arguments: "{}" }]);
    assert.equal(result.providerState?.provider, "codex");
    assert.equal(JSON.stringify(result).includes("refresh"), false);
    const persisted = await readFile(authPath, "utf8");
    assert.equal(persisted.includes("refresh"), true);
  });
});
