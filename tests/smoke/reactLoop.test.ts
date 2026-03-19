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
    sessionContext: {
      activeObjective: "Find 3 leads",
      lastRunId: "run-prev",
      lastCompletedRun: {
        runId: "run-prev",
        message: "Find 3 leads",
        assistantText: "Found 3 leads",
        artifactPaths: ["/tmp/prev.csv"]
      },
      lastArtifacts: ["/tmp/prev.csv"],
      lastOutcomeSummary: "Found 3 leads and saved CSV.",
      recentOutputs: [
        {
          id: "run-prev:lead_csv",
          kind: "lead_csv",
          runId: "run-prev",
          createdAt: "2026-03-09T10:00:05.000Z",
          title: "prev.csv",
          summary: "Found 3 leads and saved CSV.",
          artifactPath: "/tmp/prev.csv",
          availability: "body_available"
        }
      ],
      sessionSummary: "Previous turn found 3 leads.",
      recentTurns: [
        {
          role: "user",
          content: "Find 3 leads",
          runId: "run-prev",
          timestamp: "2026-03-09T10:00:00.000Z"
        },
        {
          role: "assistant",
          content: "Found 3 leads",
          runId: "run-prev",
          timestamp: "2026-03-09T10:00:05.000Z"
        }
      ]
    },
    isCancellationRequested: async () => false,
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
      cancelled: false,
      llmCallsUsed: 2,
      llmCallsRemaining: 4,
      llmUsage: {
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200,
        callCount: 2
      },
      requestedLeadCount: 50,
      rawCandidateCount: 10,
      validatedCandidateCount: 1,
      finalCandidateCount: 1,
      queryCount: 3,
      pagesVisited: 5,
      deficitCount: 49,
      sizeRangeRequested: { min: 5, max: 20 },
      sizeMatchBreakdown: {
        in_range: 1,
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
    })
  });

  assert.equal(outcome.status, "completed");
  assert.ok(outcome.artifactPaths?.[0]?.endsWith("leads.csv"));
  const updatedRun = await runStore.getRun(run.runId);
  assert.ok(updatedRun);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "alfred_loop_started"));
  assert.ok(events.some((event) => event.eventType === "session_context_loaded"));
  const sessionEvent = events.find((event) => event.eventType === "session_context_loaded");
  assert.equal(sessionEvent?.payload.recentTurnCount, 2);
  assert.equal(sessionEvent?.payload.recentOutputCount, 1);
});
