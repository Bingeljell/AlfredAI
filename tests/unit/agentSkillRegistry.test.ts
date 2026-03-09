import test from "node:test";
import assert from "node:assert/strict";
import { getAgentSkill, listAgentSkills } from "../../src/agent/skills/registry.js";
import { runAgentLoop } from "../../src/core/runAgentLoop.js";
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

test("agent skill registry exposes lead_agent metadata", () => {
  const skills = listAgentSkills();
  assert.ok(skills.some((skill) => skill.name === "lead_agent"));

  const leadSkill = getAgentSkill("lead_agent");
  assert.ok(leadSkill);
  assert.match(leadSkill?.description ?? "", /lead generation/i);
  assert.ok(Array.isArray(leadSkill?.toolAllowlist));
  assert.ok(leadSkill?.toolAllowlist?.includes("lead_pipeline"));
});

test("runAgentLoop returns failure for unknown skill", async () => {
  const workspace = await createTempWorkspace("agent-skill-registry");
  const runStore = new RunStore(workspace);

  const outcome = await runAgentLoop({
    skillName: "unknown_skill",
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "do something",
    runId: "run-1",
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
      requestedLeadCount: 0,
      rawCandidateCount: 0,
      validatedCandidateCount: 0,
      finalCandidateCount: 0,
      queryCount: 0,
      pagesVisited: 0,
      deficitCount: 0,
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
    maxIterations: 2,
    maxDurationMs: 60_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 1,
    observationWindow: 2,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.assistantText ?? "", /Unknown agent skill/);
});
