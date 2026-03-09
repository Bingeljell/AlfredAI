import test from "node:test";
import assert from "node:assert/strict";
import { runLeadAgenticLoop } from "../../src/core/runLeadAgenticLoop.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { SearchManager } from "../../src/tools/search/searchManager.js";

class FakeSearchManager {
  async search() {
    return {
      provider: "searxng" as const,
      fallbackUsed: false,
      results: []
    };
  }
}

test("runLeadAgenticLoop logs delegation and scratchpad context at loop start", async () => {
  const workspace = await createTempWorkspace("lead-agent-delegation");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "find 5 leads", "running");

  await runLeadAgenticLoop({
    parentRunId: "parent-run-1",
    delegationId: "delegation_1",
    scratchpad: {
      currentTurnObjective: "find 5 leads",
      "delegation.delegation_1.brief": "find 5 leads"
    },
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "find 5 leads",
    runId: run.runId,
    sessionId: "session-1",
    defaults: {
      searchMaxResults: 15,
      subReactMaxPages: 10,
      subReactBrowseConcurrency: 3,
      subReactBatchSize: 4,
      subReactLlmMaxCalls: 6,
      subReactMinConfidence: 0.6
    },
    leadPipelineExecutor: async () => ({
      leads: [],
      cancelled: false,
      llmCallsUsed: 0,
      llmCallsRemaining: 0,
      llmUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        callCount: 0
      },
      requestedLeadCount: 5,
      rawCandidateCount: 0,
      validatedCandidateCount: 0,
      finalCandidateCount: 0,
      queryCount: 0,
      pagesVisited: 0,
      deficitCount: 5,
      sizeRangeRequested: undefined,
      sizeMatchBreakdown: {
        in_range: 0,
        near_range: 0,
        unknown: 0,
        out_of_range: 0
      },
      relaxModeApplied: false,
      strictMinConfidence: 0.6,
      effectiveMinConfidence: 0.6,
      searchFailureCount: 0,
      searchFailureSamples: [],
      browseFailureCount: 0,
      browseFailureSamples: []
    }),
    maxIterations: 1,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 1,
    observationWindow: 2,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false
  });

  const updatedRun = await runStore.getRun(run.runId);
  assert.ok(updatedRun);
  assert.ok(updatedRun?.artifactPaths?.[0]?.endsWith("leads.csv"));
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const started = events.find((event) => event.eventType === "agent_loop_started");
  assert.ok(started);
  assert.equal(started?.payload.parentRunId, "parent-run-1");
  assert.equal(started?.payload.delegationId, "delegation_1");
  assert.deepEqual(started?.payload.scratchpadKeys, ["currentTurnObjective", "delegation.delegation_1.brief"]);
});
