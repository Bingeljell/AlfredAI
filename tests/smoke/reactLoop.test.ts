import test from "node:test";
import assert from "node:assert/strict";
import { runReActLoop } from "../../src/runtime/runReActLoop.js";
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
          title: "Example Result",
          url: "https://example.com",
          snippet: "Example",
          provider: "searxng" as const,
          rank: 1
        }
      ]
    };
  }
}

test("runReActLoop emits expected events and loads session context", async () => {
  const workspace = await createTempWorkspace("alfred-react");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "summarise the latest AI news", "running");

  const outcome = await runReActLoop("session-1", "summarise the latest AI news", run.runId, {
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    policyMode: "trusted",
    searchMaxResults: 15,
    fastScrapeCount: 1,
    enablePlaywright: false,
    maxSteps: 6,
    browseConcurrency: 3,
    sessionContext: {
      activeObjective: "Stay up to date on AI",
      sessionSummary: "Previous turn summarised AI news.",
      recentTurns: [
        {
          role: "user",
          content: "What happened in AI last week?",
          runId: "run-prev",
          timestamp: "2026-03-09T10:00:00.000Z"
        },
        {
          role: "assistant",
          content: "Here is a summary of last week's AI news.",
          runId: "run-prev",
          timestamp: "2026-03-09T10:00:05.000Z"
        }
      ]
    },
    isCancellationRequested: async () => false
  });

  assert.ok(["completed", "failed", "needs_approval"].includes(outcome.status));

  const updatedRun = await runStore.getRun(run.runId);
  assert.ok(updatedRun);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "loop_started"));
  assert.ok(events.some((event) => event.eventType === "session_context_loaded"));
  const sessionEvent = events.find((event) => event.eventType === "session_context_loaded");
  assert.equal(sessionEvent?.payload.recentTurnCount, 2);
});
