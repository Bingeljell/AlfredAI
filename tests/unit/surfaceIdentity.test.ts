import test from "node:test";
import assert from "node:assert/strict";
import { IdentityStore } from "../../src/channels/identityStore.js";
import { ChannelSessionStore } from "../../src/channels/channelSessionStore.js";
import { SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("explicit identity links share task access only within the same session, preserving delivery", async () => {
  const workspace = await createTempWorkspace("surface-identity");
  const identities = new IdentityStore(workspace);
  const store = new SchedulerTaskStore({ workspaceDir: workspace, principalAliases: (id) => identities.aliases(id) });
  await store.init();
  const task = await store.create({
    kind: "wake_turn", label: "Telegram work", owner: { sessionId: "shared", principalId: "42" },
    createdByRunId: "run", dueAt: new Date(Date.now() + 60_000).toISOString(), instruction: "Check work",
    notificationDestination: { principalId: "42", channelKey: "telegram:99" }
  });
  const owner = { sessionId: "shared", principalId: "api" };
  assert.deepEqual(await store.listForOwner(owner), []);
  await identities.linkTelegram("42");
  assert.equal((await store.listForOwner(owner))[0]?.id, task.id);
  await assert.rejects(store.cancel(task.id, { ...owner, sessionId: "another-session" }));
  assert.deepEqual((await store.get(task.id))?.notificationDestination, task.notificationDestination);
  await identities.unlinkTelegram("42");
  await assert.rejects(store.cancel(task.id, owner));
  await identities.linkTelegram("42");
  assert.equal((await store.cancel(task.id, owner)).status, "cancelled");
});

test("concurrent first messages resolve one shared channel binding", async () => {
  const workspace = await createTempWorkspace("surface-binding");
  const store = new ChannelSessionStore(workspace);
  let created = 0;
  const create = async () => ({ sessionId: `session-${++created}`, label: null, createdAt: new Date().toISOString() });
  const [a, b] = await Promise.all([store.getOrCreate("telegram:42", create), store.getOrCreate("telegram:42", create)]);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(created, 1);
});
