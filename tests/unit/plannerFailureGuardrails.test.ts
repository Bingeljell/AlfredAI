import test from "node:test";
import assert from "node:assert/strict";
import { diminishingReturnsForTests, plannerContextForTests, plannerFailureGuardrailsForTests } from "../../src/core/runLeadAgenticLoop.js";

test("reflection hints suggest search health check after unresolved search failures", () => {
  const hints = plannerFailureGuardrailsForTests.buildReflectionHints(
    [
      {
        iteration: 2,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 7,
        failedToolCount: 0,
        searchFailureCount: 5,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "lead_pipeline ok, added 0, total leads 7, search failures 5"
      }
    ],
    2
  );

  assert.ok(hints.some((hint) => hint.includes("search_status")));
});

test("extractObservationSignals captures structured tool failure counts", () => {
  const signals = plannerFailureGuardrailsForTests.extractObservationSignals([
    {
      tool: "lead_pipeline",
      status: "ok",
      durationMs: 1000,
      output: {
        searchFailureCount: 2,
        browseFailureCount: 1,
        extractionFailureCount: 3,
        extractionFailureSamples: [{ reason: "llm_budget_exhausted_before_first_attempt" }]
      }
    },
    {
      tool: "write_csv",
      status: "ok",
      durationMs: 20,
      output: {}
    }
  ]);

  assert.equal(signals.searchFailureCount, 2);
  assert.equal(signals.browseFailureCount, 1);
  assert.equal(signals.extractionFailureCount, 3);
  assert.equal(signals.semanticMissCount, 0);
  assert.equal(signals.retrievalBlockedCount, 0);
  assert.ok(signals.failureCodes.includes("search_unhealthy"));
  assert.ok(signals.failureCodes.includes("extraction_failure"));
  assert.equal(signals.hadLlmBudgetExhausted, true);
});

test("extractObservationSignals marks semantic miss and retrieval blocked failure codes", () => {
  const signals = plannerFailureGuardrailsForTests.extractObservationSignals([
    {
      tool: "lead_pipeline",
      status: "ok",
      durationMs: 1000,
      output: {
        queryCount: 5,
        pagesVisited: 9,
        rawCandidateCount: 0,
        searchFailureCount: 0,
        extractionFailureCount: 0
      }
    },
    {
      tool: "lead_pipeline",
      status: "ok",
      durationMs: 900,
      output: {
        queryCount: 5,
        pagesVisited: 0,
        rawCandidateCount: 0,
        searchFailureCount: 5,
        extractionFailureCount: 0
      }
    }
  ]);

  assert.equal(signals.semanticMissCount, 1);
  assert.equal(signals.retrievalBlockedCount, 1);
  assert.ok(signals.failureCodes.includes("semantic_miss"));
  assert.ok(signals.failureCodes.includes("search_retrieval_blocked"));
});

test("extractObservationSignals counts search tool errors as search failures", () => {
  const signals = plannerFailureGuardrailsForTests.extractObservationSignals([
    {
      tool: "search",
      status: "error",
      durationMs: 1200,
      error: "Primary search unavailable and no fallback configured"
    }
  ]);

  assert.equal(signals.searchFailureCount, 1);
  assert.equal(signals.browseFailureCount, 0);
  assert.equal(signals.extractionFailureCount, 0);
});

test("past action summary stays capped and keeps most recent items", () => {
  const baseObservation = {
    actionType: "single" as const,
    toolNames: ["lead_pipeline"],
    yieldRelevant: true,
    llmTokensUsed: 0,
    newLeadCount: 1,
    totalLeadCount: 1,
    failedToolCount: 0,
    searchFailureCount: 0,
    browseFailureCount: 0,
    extractionFailureCount: 0,
    hadLlmBudgetExhausted: false
  };
  const observations = Array.from({ length: 8 }, (_, index) => ({
    ...baseObservation,
    iteration: index + 1,
    note: `lead_pipeline(maxPages=${8 + index}) ok, added=${index}, total=${index + 1}`
  }));

  const summary = plannerContextForTests.buildPastActionsSummary(observations, 140, 8);
  const serialized = summary.join("\n");

  assert.ok(summary.length >= 1);
  assert.ok(serialized.length <= 140);
  assert.match(serialized, /iteration 8/);
});

test("recent performance summary includes yield and diagnostics counters", () => {
  const summary = plannerContextForTests.buildRecentPerformanceSummary(
    [
      {
        iteration: 1,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "lead_pipeline attempt 1"
      },
      {
        iteration: 2,
        actionType: "single",
        toolNames: ["search_status"],
        yieldRelevant: false,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 5,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "search_status check"
      }
    ],
    2
  );

  assert.match(summary, /yieldAttempts=1/);
  assert.match(summary, /diagnosticActions=1/);
  assert.match(summary, /searchFailures=5/);
});

test("atomic next-action hint prefers shortlist before heavier retrieval", () => {
  const hint = plannerContextForTests.determineAtomicNextActionHint({
    objectiveQuery: "managed service providers usa",
    shortlistedUrlsCount: 0,
    fetchedPagesCount: 0,
    leadCount: 0,
    emailRequested: true,
    budgetMode: "normal",
    expectedLlmCapThisIteration: 8,
    targetLeadCount: 3
  });

  assert.equal(hint.tool, "lead_search_shortlist");
  assert.match(hint.rationale, /shortlist/i);
});

test("diminishing returns ignores diagnostic-only actions", () => {
  const shouldNotStop = diminishingReturnsForTests.computeDiminishingReturns(
    [
      {
        iteration: 1,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "lead_pipeline yielded zero"
      },
      {
        iteration: 2,
        actionType: "single",
        toolNames: ["search_status"],
        yieldRelevant: false,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 5,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "diagnostic"
      },
      {
        iteration: 3,
        actionType: "single",
        toolNames: ["search_status"],
        yieldRelevant: false,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "diagnostic again"
      }
    ],
    2
  );

  const shouldStop = diminishingReturnsForTests.computeDiminishingReturns(
    [
      {
        iteration: 1,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "yield attempt one"
      },
      {
        iteration: 2,
        actionType: "single",
        toolNames: ["search_status"],
        yieldRelevant: false,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 5,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "diagnostic"
      },
      {
        iteration: 3,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
        llmTokensUsed: 0,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "yield attempt two"
      }
    ],
    2
  );

  assert.equal(shouldNotStop, false);
  assert.equal(shouldStop, true);
});

test("search query guardrail fills missing/invalid query from user message", () => {
  const guarded = plannerFailureGuardrailsForTests.applySearchQueryGuardrail(
    [
      {
        tool: "search",
        input: {}
      }
    ],
    "Find 20 MSP/SI leads in USA with emails"
  );

  assert.equal(guarded.adjusted, true);
  assert.equal(guarded.reason, "search_query_missing_or_invalid");
  assert.equal(guarded.calls[0]?.tool, "search");
  assert.equal(guarded.calls[0]?.input.query, "Find 20 MSP/SI leads in USA with emails");
});

test("reflection hints flag repeated low-yield semantic misses without forcing a replacement action", () => {
  const hints = plannerFailureGuardrailsForTests.buildReflectionHints(
    [
      {
        iteration: 1,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
        llmTokensUsed: 1000,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 1,
        extractionFailureCount: 0,
        semanticMissCount: 1,
        retrievalBlockedCount: 0,
        failureCodes: ["semantic_miss"],
        leadPipelineInputSummaries: ["maxPages=10, llmMaxCalls=12, batch=6, concurrency=6, minConf=0.7, emailEnrichment=true"],
        hadLlmBudgetExhausted: false,
        note: "first low-yield pass"
      },
      {
        iteration: 2,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
        llmTokensUsed: 1200,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        semanticMissCount: 1,
        retrievalBlockedCount: 0,
        failureCodes: ["semantic_miss"],
        leadPipelineInputSummaries: ["maxPages=10, llmMaxCalls=12, batch=6, concurrency=6, minConf=0.7, emailEnrichment=true"],
        hadLlmBudgetExhausted: false,
        note: "second low-yield pass"
      }
    ],
    2
  );

  assert.ok(hints.some((hint) => hint.includes("semantic miss")));
  assert.ok(hints.some((hint) => hint.includes("maxPages=10")));
});

test("yield-per-token signal uses rolling last two yield attempts", () => {
  const signal = plannerContextForTests.computeYieldPerTokenSignal([
    {
      iteration: 1,
      actionType: "single",
      toolNames: ["lead_pipeline"],
      budgetMode: "normal",
      yieldRelevant: true,
      llmTokensUsed: 1000,
      newLeadCount: 3,
      totalLeadCount: 3,
      failedToolCount: 0,
      searchFailureCount: 0,
      browseFailureCount: 0,
      extractionFailureCount: 0,
      hadLlmBudgetExhausted: false,
      note: "yield one"
    },
    {
      iteration: 2,
      actionType: "single",
      toolNames: ["lead_pipeline"],
      budgetMode: "normal",
      yieldRelevant: true,
      llmTokensUsed: 2000,
      newLeadCount: 1,
      totalLeadCount: 4,
      failedToolCount: 0,
      searchFailureCount: 0,
      browseFailureCount: 0,
      extractionFailureCount: 0,
      hadLlmBudgetExhausted: false,
      note: "yield two"
    },
    {
      iteration: 3,
      actionType: "single",
      toolNames: ["lead_pipeline"],
      budgetMode: "normal",
      yieldRelevant: true,
      llmTokensUsed: 2000,
      newLeadCount: 0,
      totalLeadCount: 4,
      failedToolCount: 0,
      searchFailureCount: 0,
      browseFailureCount: 0,
      extractionFailureCount: 0,
      hadLlmBudgetExhausted: false,
      note: "yield three"
    }
  ]);

  assert.equal(signal.sampleCount, 2);
  assert.equal(signal.status, "low");
  assert.ok(signal.averageLeadsPer1kTokens < signal.threshold);
});

test("expected llm cap decays by mode and rewards high yield", () => {
  const firstConserve = plannerContextForTests.computeExpectedLlmCapForIteration({
    mode: "conserve",
    observations: [],
    highYieldThreshold: 3
  });
  assert.equal(firstConserve, 12);

  const secondConserve = plannerContextForTests.computeExpectedLlmCapForIteration({
    mode: "conserve",
    observations: [
      {
        iteration: 1,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        budgetMode: "conserve",
        expectedLlmCap: 12,
        yieldRelevant: true,
        llmTokensUsed: 1500,
        newLeadCount: 0,
        totalLeadCount: 0,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "conserve one"
      }
    ],
    highYieldThreshold: 3
  });
  assert.equal(secondConserve, 10);

  const emergencyWithHighYield = plannerContextForTests.computeExpectedLlmCapForIteration({
    mode: "emergency",
    observations: [
      {
        iteration: 2,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        budgetMode: "emergency",
        expectedLlmCap: 6,
        yieldRelevant: true,
        llmTokensUsed: 2200,
        newLeadCount: 4,
        totalLeadCount: 6,
        failedToolCount: 0,
        searchFailureCount: 0,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "emergency high yield"
      }
    ],
    highYieldThreshold: 3
  });
  assert.equal(emergencyWithHighYield, 7);
});

test("deficit strategy switches to polish_only at mode thresholds", () => {
  const normal = plannerContextForTests.computeDeficitStrategy({
    requestedLeadCount: 20,
    currentLeadCount: 15,
    mode: "normal",
    emailRequested: false
  });
  assert.equal(normal.recommendation, "polish_only");
  assert.equal(normal.threshold, 5);

  const emergencyGrowth = plannerContextForTests.computeDeficitStrategy({
    requestedLeadCount: 20,
    currentLeadCount: 16,
    mode: "emergency",
    emailRequested: true
  });
  assert.equal(emergencyGrowth.recommendation, "growth");
  assert.equal(emergencyGrowth.threshold, 3);

  const emergencyPolish = plannerContextForTests.computeDeficitStrategy({
    requestedLeadCount: 20,
    currentLeadCount: 17,
    mode: "emergency",
    emailRequested: true
  });
  assert.equal(emergencyPolish.recommendation, "polish_only");
});
