import test from "node:test";
import assert from "node:assert/strict";
import { AlfredAgentRuntime } from "../../src/runtime/agentRuntime.js";
import type { AgentRuntimeServices } from "../../src/runtime/agentRuntime.js";
import { getPolicyMode } from "../../src/config/env.js";

test("AlfredAgentRuntime delegates a turn without exposing provider selection to ChatService", async () => {
  const calls: Array<{ sessionId: string; message: string; runId: string; options: Record<string, unknown> }> = [];
  const expected = { status: "completed" as const, assistantText: "done" };
  const services: AgentRuntimeServices = {
    runStore: {
      isCancellationRequested: async () => false
    } as never,
    searchManager: {} as never,
    workspaceDir: "/tmp/alfred-runtime-test",
    searchMaxResults: 11,
    fastScrapeCount: 2,
    enablePlaywright: false,
    maxSteps: 7,
    browseConcurrency: 3,
    agentMaxDurationMs: 60_000,
    agentMaxToolCalls: 12,
    agentMaxParallelTools: 2,
    runLoopRunner: async (sessionId, message, runId, options) => {
      calls.push({ sessionId, message, runId, options: options as unknown as Record<string, unknown> });
      return expected;
    }
  };
  const runtime = new AlfredAgentRuntime(services);

  const result = await runtime.runTurn({
    runId: "run-1",
    sessionId: "session-1",
    message: "Do the thing",
    executionProfile: {
      origin: "scheduler",
      maxIterations: 5,
      maxToolCalls: 5,
      maxDurationMs: 60_000,
      toolAllowlist: ["run_status"],
      persistConversation: false
    }
  });

  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.sessionId, "session-1");
  assert.deepEqual(calls[0]?.message, "Do the thing");
  assert.deepEqual(calls[0]?.runId, "run-1");
  assert.equal(typeof calls[0]?.options.isCancellationRequested, "function");
  assert.equal(calls[0]?.options.policyMode, getPolicyMode());
  assert.equal(calls[0]?.options.systemPrompt !== undefined, true);
});
