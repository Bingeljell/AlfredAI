import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionStore } from "../../src/memory/sessionStore.js";
import { RunStore } from "../../src/runs/runStore.js";
import { ChannelSessionStore } from "../../src/channels/telegram/channelSessionStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("concurrent session and channel mutations survive across store instances", async () => {
  const workspace = await createTempWorkspace("store-concurrency");
  const stores = [new SessionStore(workspace), new SessionStore(workspace)];
  const sessions = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2]!.createSession(`Session ${i}`)));
  assert.equal((await stores[0]!.listSessions(100)).length, 20);
  await Promise.all([
    stores[0]!.updateWorkingMemory(sessions[0]!.id, { activeObjective: "Preserve me" }),
    stores[1]!.setPreferences(sessions[0]!.id, { modelId: "model" })
  ]);
  const session = await stores[0]!.getSession(sessions[0]!.id);
  assert.equal(session?.workingMemory?.activeObjective, "Preserve me");
  assert.equal(session?.preferences?.modelId, "model");
  const channels = [new ChannelSessionStore(workspace), new ChannelSessionStore(workspace)];
  await Promise.all(sessions.map((session, i) => channels[i % 2]!.set(`telegram:${i}`, { sessionId: session.id, label: null, createdAt: session.createdAt })));
  assert.equal(Object.keys(await channels[0]!.getAll()).length, 20);
});

test("parallel tool receipts, usage, text, and cancellation do not overwrite each other", async () => {
  const workspace = await createTempWorkspace("run-concurrency");
  const store = new RunStore(workspace);
  const run = await store.createRun("session", "work", "running");
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => store.addToolCall(run.runId, { toolName: `tool_${i}`, inputRedacted: {}, outputRedacted: {}, durationMs: 1, status: "ok", timestamp: run.createdAt })),
    ...Array.from({ length: 10 }, () => store.addLlmUsage(run.runId, { promptTokens: 1, completionTokens: 1, totalTokens: 2 })),
    store.updateRun(run.runId, { assistantText: "Partial result" }),
    store.requestCancellation(run.runId)
  ]);
  const updated = await store.getRun(run.runId);
  assert.equal(updated?.toolCalls.length, 10);
  assert.equal(updated?.llmUsage?.totalTokens, 20);
  assert.equal(updated?.assistantText, "Partial result");
  assert.ok(updated?.cancelRequestedAt);
});

test("a corrupt session index is preserved for recovery rather than replaced", async () => {
  const workspace = await createTempWorkspace("corrupt-session-index");
  const store = new SessionStore(workspace);
  await store.createSession("Original");
  const file = path.join(workspace, "sessions/sessions.json");
  await writeFile(file, "broken-json");
  await assert.rejects(store.createSession("New"));
  assert.equal(await readFile(file, "utf8"), "broken-json");
});
