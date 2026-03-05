import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../../src/gateway/app.js";

test("POST /v1/sessions create and GET /v1/sessions list", async () => {
  const createRes = await app.request("http://localhost/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create", name: "API Session" })
  });

  assert.equal(createRes.status, 200);
  const createBody = (await createRes.json()) as { session: { id: string } };
  assert.ok(createBody.session.id);

  const listRes = await app.request("http://localhost/v1/sessions");
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { sessions: Array<{ id: string }> };
  assert.ok(listBody.sessions.some((session) => session.id === createBody.session.id));
});
