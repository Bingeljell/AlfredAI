import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../../src/gateway/app.js";

test("scheduler status is explicit when the opt-in feature is disabled", async () => {
  const response = await app.request("http://localhost/v1/scheduler/status");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false, running: false });
});

