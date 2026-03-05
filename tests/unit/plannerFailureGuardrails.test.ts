import test from "node:test";
import assert from "node:assert/strict";
import { plannerContextForTests, plannerFailureGuardrailsForTests } from "../../src/core/runLeadAgenticLoop.js";

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
