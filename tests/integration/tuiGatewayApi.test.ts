import test from "node:test";
import assert from "node:assert/strict";
import { app, chatService } from "../../src/gateway/app.js";

test("TUI ingress preserves the session, derives API identity, and keeps web compatibility", async () => {
  const original = chatService.handleTurn;
  const captured: Array<Parameters<typeof original>[0]> = [];
  chatService.handleTurn = async (input) => { captured.push(input); return { runId: "test-run", status: "queued" }; };
  try {
    for (const surface of ["tui", undefined]) {
      const response = await app.request("/v1/chat/turn", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "shared-session", message: "Continue", surface, principalId: "spoofed", requestJob: true })
      });
      assert.equal(response.status, 200);
    }
    assert.equal(captured[0]?.sessionId, "shared-session");
    assert.equal(captured[0]?.origin, "tui");
    assert.equal(captured[0]?.principalId, "api");
    assert.equal(captured[0]?.channelKey, "tui:shared-session");
    assert.equal(captured[1]?.origin, "web");
    const rejected = await app.request("/v1/chat/turn", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s", message: "Continue", surface: "telegram" })
    });
    assert.equal(rejected.status, 400);
  } finally { chatService.handleTurn = original; }
});

test("conversation streams use the existing gateway authentication boundary", async () => {
  const previous = process.env.ALFRED_API_KEY;
  process.env.ALFRED_API_KEY = "test-stream-key";
  try {
    assert.equal((await app.request("/v1/sessions/missing/stream")).status, 401);
    assert.equal((await app.request("/v1/sessions/missing/stream", { headers: { "X-Api-Key": "test-stream-key" } })).status, 404);
  } finally { process.env.ALFRED_API_KEY = previous; }
});
