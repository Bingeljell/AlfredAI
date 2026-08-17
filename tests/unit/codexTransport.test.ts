import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCodexCredentials } from "../../src/provider/codex/auth.js";
import { CODEX_RESPONSES_ENDPOINT, CodexTransport } from "../../src/provider/codex/transport.js";

function token(accountId: string): string {
  const header = Buffer.from("{}", "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth.chatgpt_account_id": accountId })).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function withAuth<T>(fn: (authPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alfred-codex-transport-"));
  const authPath = path.join(dir, "auth.json");
  try {
    await writeCodexCredentials({ version: 1, provider: "codex", accessToken: token("acct-transport"), refreshToken: "refresh", expiresAtMs: Date.now() + 3_600_000, accountId: "acct-transport" }, authPath);
    return await fn(authPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Codex transport sends the private Responses request with semantic headers", async () => {
  await withAuth(async (authPath) => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response("data: {\"type\":\"response.done\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n", { status: 200 });
    };
    const result = await new CodexTransport({ authFilePath: authPath, fetchImpl }).request({
      model: "codex-mini",
      sessionId: "session-secret",
      messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }],
      tools: [{ name: "search", description: "Search", parameters: { type: "object" } }]
    });
    assert.equal(result.ok, true);
    assert.equal(seenUrl, CODEX_RESPONSES_ENDPOINT);
    const headers = new Headers(seenInit?.headers);
    assert.match(headers.get("authorization") ?? "", /^Bearer /);
    assert.equal(headers.get("chatgpt-account-id"), "acct-transport");
    assert.equal(headers.get("originator"), "alfred");
    assert.equal(headers.get("openai-beta"), "responses=experimental");
    assert.equal(headers.get("accept"), "text/event-stream");
    assert.equal(headers.get("session-id"), headers.get("x-client-request-id"));
    const body = JSON.parse(String(seenInit?.body)) as Record<string, any>;
    assert.equal(body.store, false);
    assert.equal(body.instructions, "system");
    assert.equal(body.tools[0].type, "function");
    assert.equal(JSON.stringify(body).includes("session-secret"), false);
    if (result.ok) result.cleanup();
  });
});

test("Codex transport refreshes once after 401 and resends without exposing auth data", async () => {
  await withAuth(async (authPath) => {
    let responseCalls = 0;
    let refreshCalls = 0;
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith("/oauth/token")) {
        refreshCalls += 1;
        return new Response(JSON.stringify({ access_token: token("acct-rotated"), refresh_token: "refresh-rotated", expires_in: 3600 }), { status: 200 });
      }
      responseCalls += 1;
      if (responseCalls === 1) return new Response("unauthorized", { status: 401 });
      return new Response("data: {\"type\":\"response.done\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n", { status: 200 });
    };
    const result = await new CodexTransport({ authFilePath: authPath, fetchImpl }).request({
      model: "codex-mini",
      messages: [{ role: "user", content: "hello" }],
      maxAttempts: 1
    });
    assert.equal(result.ok, true);
    assert.equal(responseCalls, 2);
    assert.equal(refreshCalls, 1);
    if (result.ok) result.cleanup();
  });
});
