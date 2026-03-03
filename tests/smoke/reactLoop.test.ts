import test from "node:test";
import assert from "node:assert/strict";
import { runReActLoop } from "../../src/core/runReActLoop.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { SearchManager } from "../../src/tools/search/searchManager.js";

class FakeSearchManager {
  async search() {
    return {
      provider: "searxng" as const,
      fallbackUsed: false,
      results: [
        {
          title: "Example Company",
          url: "https://example.com",
          snippet: "Example",
          provider: "searxng" as const,
          rank: 1
        }
      ]
    };
  }
}

test("runReActLoop produces a completed outcome with artifact", async () => {
  const workspace = await createTempWorkspace("alfred-react");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "find 50 leads", "running");

  const outcome = await runReActLoop("session-1", "find 50 leads in india", run.runId, {
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    policyMode: "trusted",
    searchMaxResults: 15,
    fastScrapeCount: 1,
    enablePlaywright: false,
    maxSteps: 6,
    subReactMaxPages: 10,
    subReactBrowseConcurrency: 3,
    subReactBatchSize: 4,
    subReactLlmMaxCalls: 6,
    subReactMinConfidence: 0.6,
    leadPipelineExecutor: async () => ({
      leads: [
        {
          companyName: "Acme Tech",
          website: "https://acmetech.example",
          location: "India",
          shortDesc: "Managed IT and SI services provider",
          sourceUrl: "https://example.com",
          confidence: 0.82,
          evidence: "Listed on source directory as managed service provider"
        }
      ],
      llmCallsUsed: 2,
      llmCallsRemaining: 4,
      requestedLeadCount: 50,
      rawCandidateCount: 10,
      validatedCandidateCount: 1,
      finalCandidateCount: 1,
      queryCount: 3,
      pagesVisited: 5,
      deficitCount: 49
    })
  });

  assert.equal(outcome.status, "completed");
  assert.ok(outcome.artifactPaths?.[0]?.endsWith("leads.csv"));
});
