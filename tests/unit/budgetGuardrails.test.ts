import test from "node:test";
import assert from "node:assert/strict";
import { budgetGuardrailsForTests } from "../../src/core/runLeadAgenticLoop.js";

test("lead pipeline time budget downscales crawl settings as remaining time drops", () => {
  const adjusted = budgetGuardrailsForTests.applyLeadPipelineTimeBudget(
    {
      maxPages: 25,
      llmMaxCalls: 10,
      browseConcurrency: 5,
      extractionBatchSize: 6
    },
    110_000
  );

  assert.equal(adjusted.maxPages, 8);
  assert.equal(adjusted.llmMaxCalls, 3);
  assert.equal(adjusted.browseConcurrency, 2);
  assert.equal(adjusted.extractionBatchSize, 3);
});

test("minimum safe lead_pipeline start threshold is 90s", () => {
  assert.equal(budgetGuardrailsForTests.MIN_LEAD_PIPELINE_START_MS, 90_000);
});
