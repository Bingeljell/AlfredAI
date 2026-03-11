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

test("runSpecialistToolLoop enforces research contract before allowing respond", async () => {
  const workspace = await createTempWorkspace("specialist-contract-gate");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI news and draft a cited blog post",
    "running"
  );

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "Research AI news and draft a cited blog post",
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
    maxIterations: 1,
    maxDurationMs: 60_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search", "run_diagnostics"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "I can answer now.",
          actionType: "respond",
          singleTool: null,
          singleInputJson: null,
          parallelActions: null,
          responseText: "Here is a short summary."
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  assert.match(outcome.assistantText ?? "", /could not complete the requested draft/i);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "specialist_contract_blocked"));
});

test("runSpecialistToolLoop triggers loop-shape guard after repeated search-only iterations", async () => {
  const workspace = await createTempWorkspace("specialist-loop-shape-guard");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "research this", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "Research this topic",
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
    maxIterations: 6,
    maxDurationMs: 60_000,
    maxToolCalls: 10,
    maxParallelTools: 1,
    plannerMaxCalls: 6,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Search first.",
          actionType: "single",
          singleTool: "search",
          singleInputJson: JSON.stringify({ query: "ai news", maxResults: 5 }),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "specialist_loop_guard_triggered"));
});
