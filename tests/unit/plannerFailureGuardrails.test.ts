import test from "node:test";
import assert from "node:assert/strict";
import { diminishingReturnsForTests, plannerContextForTests, plannerFailureGuardrailsForTests } from "../../src/core/runLeadAgenticLoop.js";

test("failure guardrail forces search_status after lead_pipeline search failures", () => {
  const guarded = plannerFailureGuardrailsForTests.applyFailureGuardrail(
    {
      type: "single",
      tool: "lead_pipeline",
      input: { maxPages: 20 }
    },
    [
      {
        iteration: 2,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
        newLeadCount: 0,
        totalLeadCount: 7,
        failedToolCount: 0,
        searchFailureCount: 5,
        browseFailureCount: 0,
        extractionFailureCount: 0,
        hadLlmBudgetExhausted: false,
        note: "lead_pipeline ok, added 0, total leads 7, search failures 5"
      }
    ]
  );

  assert.equal(guarded.adjusted, true);
  assert.equal(guarded.action.type, "single");
  if (guarded.action.type === "single") {
    assert.equal(guarded.action.tool, "search_status");
  }
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
  assert.equal(signals.hadLlmBudgetExhausted, true);
});

test("past action summary stays capped and keeps most recent items", () => {
  const baseObservation = {
    actionType: "single" as const,
    toolNames: ["lead_pipeline"],
    yieldRelevant: true,
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

test("diminishing returns ignores diagnostic-only actions", () => {
  const shouldNotStop = diminishingReturnsForTests.computeDiminishingReturns(
    [
      {
        iteration: 1,
        actionType: "single",
        toolNames: ["lead_pipeline"],
        yieldRelevant: true,
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
