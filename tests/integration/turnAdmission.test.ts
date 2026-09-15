import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ChatService } from "../../src/runner/chatService.js";
import { SessionStore } from "../../src/memory/sessionStore.js";
import { RunStore } from "../../src/runs/runStore.js";
import { InMemoryQueue } from "../../src/workers/inMemoryQueue.js";
import type { AgentRuntime, AgentTurnRequest } from "../../src/runtime/agentRuntime.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("queued admission is immediate, builds fresh context, and deduplicates across service restarts", { timeout: 5_000 }, async () => {
  const workspace = await createTempWorkspace("turn-admission");
  const sessions = new SessionStore(workspace);
  const runs = new RunStore(workspace);
  const session = await sessions.createSession("Shared");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: AgentTurnRequest[] = [];
  const runtime: AgentRuntime = { async runTurn(request) {
    calls.push(request);
    if (request.message === "first") await gate;
    return { status: "completed", assistantText: `Answer to ${request.message}` };
  } };
  const options = {
    sessionStore: sessions, runStore: runs, searchManager: {} as never, queue: new InMemoryQueue(2),
    workspaceDir: workspace, searchMaxResults: 5, fastScrapeCount: 2, enablePlaywright: false,
    maxSteps: 4, browseConcurrency: 2, agentMaxDurationMs: 60_000, agentMaxToolCalls: 8,
    agentMaxParallelTools: 2, agentRuntime: runtime
  };
  const service = new ChatService(options);
  const submit = (message: string, requestId: string) => ({ sessionId: session.id, message, requestJob: true, requestId, principalId: "api", origin: "tui" as const });
  try {
    const first = await service.handleTurn(submit("first", "request-1"));
    const second = await service.handleTurn(submit("second", "request-2"));
    assert.equal(second.status, "queued");
    assert.equal((await runs.getRun(second.runId))?.status, "queued");
    assert.equal((await service.handleTurn(submit("first", "request-1"))).runId, first.runId);
    await assert.rejects(service.handleTurn(submit("changed", "request-1")), /request_id_conflict/);
    const third = await service.handleTurn(submit("cancel me", "request-3"));
    await service.requestRunCancellation(third.runId);
    release();
    for (let i = 0; i < 200 && (await runs.getRun(third.runId))?.status !== "cancelled"; i++) await delay(10);
    assert.equal((await runs.getRun(third.runId))?.status, "cancelled");
    assert.deepEqual(calls.map((request) => request.message), ["first", "second"]);
    assert.ok(calls[1]?.sessionContext?.conversationWindow?.some((entry) => entry.content === "Answer to first"));
    const restarted = new ChatService(options);
    assert.equal((await restarted.handleTurn(submit("second", "request-2"))).runId, second.runId);
    assert.equal(calls.length, 2);
  } finally { release(); }
});
