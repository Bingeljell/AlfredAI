import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/memory/sessionStore.js";
import { RunStore } from "../../src/runs/runStore.js";
import { ChatService } from "../../src/services/chatService.js";
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

test("session store updates and resets working memory", async () => {
  const workspace = await createTempWorkspace("alfred-session-memory");
  const store = new SessionStore(workspace);
  const created = await store.createSession("Continuity");

  await store.updateWorkingMemory(created.id, {
    activeObjective: "Find 3 leads",
    lastRunId: "run-1",
    lastArtifacts: ["/tmp/leads.csv"]
  });

  const updated = await store.getSession(created.id);
  assert.equal(updated?.workingMemory?.activeObjective, "Find 3 leads");
  assert.deepEqual(updated?.workingMemory?.lastArtifacts, ["/tmp/leads.csv"]);

  await store.resetWorkingMemory(created.id);
  const reset = await store.getSession(created.id);
  assert.equal(reset?.workingMemory, undefined);
});

test("chat service injects session context on follow-up turns and supports /newsession", async () => {
  const workspace = await createTempWorkspace("alfred-chat-memory");
  const sessionStore = new SessionStore(workspace);
  const runStore = new RunStore(workspace);
  const session = await sessionStore.createSession("Continuity");
  const capturedContexts: Array<unknown> = [];

  const chatService = new ChatService({
    sessionStore,
    runStore,
    searchManager: {} as never,
    queue: {
      enqueue(task: () => Promise<void>) {
        void task();
      }
    } as never,
    workspaceDir: workspace,
    searchMaxResults: 15,
    fastScrapeCount: 5,
    enablePlaywright: false,
    maxSteps: 4,
    subReactMaxPages: 10,
    subReactBrowseConcurrency: 2,
    subReactBatchSize: 3,
    subReactLlmMaxCalls: 4,
    subReactMinConfidence: 0.6,
    agentMaxDurationMs: 60_000,
    agentMaxToolCalls: 8,
    agentMaxParallelTools: 2,
    agentPlannerMaxCalls: 4,
    agentObservationWindow: 4,
    agentDiminishingThreshold: 2,
    runLoopRunner: async (_sessionId, message, _runId, options) => {
      capturedContexts.push(options.sessionContext);
      return {
        status: "completed",
        assistantText: `Handled: ${message}`,
        artifactPaths: ["/tmp/leads.csv"]
      };
    }
  });

  await chatService.handleTurn({
    sessionId: session.id,
    message: "Find 3 leads"
  });

  const followUp = await chatService.handleTurn({
    sessionId: session.id,
    message: "Paste them"
  });

  assert.equal(followUp.status, "completed");
  assert.equal(capturedContexts.length, 2);
  const firstContext = capturedContexts[0] as {
    recentTurns?: Array<{ role: string; content: string }>;
  };
  assert.equal(firstContext.recentTurns?.length, 1);
  assert.equal(firstContext.recentTurns?.[0]?.role, "user");
  assert.equal(firstContext.recentTurns?.[0]?.content, "Find 3 leads");
  const secondContext = capturedContexts[1] as {
    lastCompletedRun?: { message?: string; artifactPaths?: string[] };
    lastOutcomeSummary?: string;
    recentTurns?: Array<{ role: string; content: string }>;
    recentOutputs?: Array<{
      kind: string;
      availability: string;
      title: string;
      artifactPath?: string;
    }>;
  };
  assert.equal(secondContext.lastCompletedRun?.message, "Find 3 leads");
  assert.deepEqual(secondContext.lastCompletedRun?.artifactPaths, ["/tmp/leads.csv"]);
  assert.match(secondContext.lastOutcomeSummary ?? "", /Handled: Find 3 leads/);
  assert.equal(secondContext.recentOutputs?.length, 1);
  assert.equal(secondContext.recentOutputs?.[0]?.kind, "lead_csv");
  assert.equal(secondContext.recentOutputs?.[0]?.availability, "body_available");
  assert.equal(secondContext.recentOutputs?.[0]?.artifactPath, "/tmp/leads.csv");
  assert.ok(secondContext.recentTurns?.some((turn) => turn.role === "user" && turn.content === "Find 3 leads"));
  assert.ok(secondContext.recentTurns?.some((turn) => turn.role === "assistant" && /Handled: Find 3 leads/.test(turn.content)));
  assert.equal(secondContext.recentTurns?.at(-1)?.role, "user");
  assert.equal(secondContext.recentTurns?.at(-1)?.content, "Paste them");

  const reset = await chatService.handleTurn({
    sessionId: session.id,
    message: "/newsession"
  });
  assert.equal(reset.status, "completed");

  const afterReset = await sessionStore.getSession(session.id);
  assert.equal(afterReset?.workingMemory, undefined);
});
