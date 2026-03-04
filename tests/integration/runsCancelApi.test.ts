import test from "node:test";
import assert from "node:assert/strict";
import { app, runStore } from "../../src/gateway/app.js";

test("POST /v1/runs/:runId/cancel marks queued run as cancellation requested", async () => {
  const run = await runStore.createRun("session-cancel-test", "find 20 leads", "queued");

  const cancelRes = await app.request(`http://localhost/v1/runs/${run.runId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });

  assert.equal(cancelRes.status, 200);
  const cancelBody = (await cancelRes.json()) as {
    runId: string;
    accepted: boolean;
    message: string;
  };

  assert.equal(cancelBody.runId, run.runId);
  assert.equal(cancelBody.accepted, true);
  assert.match(cancelBody.message, /Cancellation requested/i);

  const updated = await runStore.getRun(run.runId);
  assert.ok(updated?.cancelRequestedAt);
});
