import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_OAUTH_CONSTANTS, loginCodexDevice } from "../../src/provider/codex/oauth.js";

test("Codex device login reports timeout after pending polls", async () => {
  let polls = 0;
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url) === CODEX_OAUTH_CONSTANTS.deviceUserCodeEndpoint) {
      return new Response(JSON.stringify({ device_auth_id: "device-timeout", user_code: "TIME-OUT", interval: 0.01 }), { status: 200 });
    }
    polls += 1;
    return new Response("pending", { status: 403 });
  };
  await assert.rejects(
    () => loginCodexDevice({ fetchImpl, deviceTimeoutMs: 65 }),
    /device login timed out/
  );
  assert.ok(polls > 0);
});

test("Codex device login cancels while waiting between polls", async () => {
  const controller = new AbortController();
  let polls = 0;
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url) === CODEX_OAUTH_CONSTANTS.deviceUserCodeEndpoint) {
      setTimeout(() => controller.abort("test cancellation"), 10);
      return new Response(JSON.stringify({ device_auth_id: "device-cancel", user_code: "CANCEL", interval: 0.1 }), { status: 200 });
    }
    polls += 1;
    return new Response("pending", { status: 403 });
  };
  await assert.rejects(
    () => loginCodexDevice({ fetchImpl, signal: controller.signal, deviceTimeoutMs: 500 }),
    /login cancelled/
  );
  assert.equal(polls, 0);
});
