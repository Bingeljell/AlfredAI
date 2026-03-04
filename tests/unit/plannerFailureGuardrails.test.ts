import test from "node:test";
import assert from "node:assert/strict";
import { plannerFailureGuardrailsForTests } from "../../src/core/runLeadAgenticLoop.js";

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
