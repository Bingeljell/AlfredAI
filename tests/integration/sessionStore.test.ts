import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/memory/sessionStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("session store creates and lists sessions", async () => {
  const workspace = await createTempWorkspace("alfred-sessions");
  const store = new SessionStore(workspace);

  const created = await store.createSession("Prospecting");
  assert.ok(created.id);

  const listed = await store.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Prospecting");
});
