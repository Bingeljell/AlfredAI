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
    maxSteps: 6
  });

  assert.equal(outcome.status, "completed");
  assert.ok(outcome.artifactPaths?.[0]?.endsWith("leads.csv"));
});
