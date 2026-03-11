import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../src/runs/runStore.js";
import { runSpecialistToolLoop } from "../../src/core/runSpecialistToolLoop.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class FakeSearchManager {
  async search() {
    return {
      provider: "searxng" as const,
      fallbackUsed: false,
      results: []
    };
  }
}

test("runSpecialistToolLoop exits with policy block when planner auth fails", async () => {
  const workspace = await createTempWorkspace("specialist-policy-block");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "research this", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "research this",
    runId: run.runId,
    sessionId: "session-1",
    openAiApiKey: "test-key",
    defaults: {
      searchMaxResults: 15,
      subReactMaxPages: 10,
      subReactBrowseConcurrency: 3,
      subReactBatchSize: 4,
      subReactLlmMaxCalls: 6,
      subReactMinConfidence: 0.6
    },
    leadPipelineExecutor: async () => {
      throw new Error("lead pipeline should not run in this test");
    },
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["run_diagnostics"],
    structuredChatRunner: async () => ({
      failureCode: "http_error",
      failureClass: "policy_block",
      failureMessage: "OpenAI returned status 401",
      statusCode: 401
    })
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.assistantText ?? "", /blocked by policy\/auth/i);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "specialist_planner_failed"));
});
