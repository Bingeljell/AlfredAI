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
    110_000,
    "normal"
  );

  assert.equal(adjusted.maxPages, 8);
  assert.equal(adjusted.llmMaxCalls, 3);
  assert.equal(adjusted.browseConcurrency, 2);
  assert.equal(adjusted.extractionBatchSize, 3);
});

test("mode bounds clamp lead pipeline aggressively in emergency mode", () => {
  const adjusted = budgetGuardrailsForTests.applyLeadPipelineTimeBudget(
    {
      maxPages: 25,
      llmMaxCalls: 12,
      browseConcurrency: 6,
      extractionBatchSize: 6
    },
    200_000,
    "emergency"
  );

  assert.equal(adjusted.maxPages, 5);
  assert.equal(adjusted.llmMaxCalls, 6);
  assert.equal(adjusted.browseConcurrency, 2);
  assert.equal(adjusted.extractionBatchSize, 2);
});

test("minimum safe lead_pipeline start threshold adapts by budget mode", () => {
  assert.equal(budgetGuardrailsForTests.minLeadPipelineStartMsForMode("normal"), 30_000);
  assert.equal(budgetGuardrailsForTests.minLeadPipelineStartMsForMode("conserve"), 15_000);
  assert.equal(budgetGuardrailsForTests.minLeadPipelineStartMsForMode("emergency"), 5_000);
});

test("lead pipeline time budget honors expected per-iteration llm cap", () => {
  const adjusted = budgetGuardrailsForTests.applyLeadPipelineTimeBudget(
    {
      maxPages: 12,
      llmMaxCalls: 12,
      browseConcurrency: 3,
      extractionBatchSize: 3
    },
    250_000,
    "conserve",
    8
  );

  assert.equal(adjusted.llmMaxCalls, 8);
});

test("dynamic iteration ceiling expands under healthy budget and high deficit", () => {
  const ceiling = budgetGuardrailsForTests.computeDynamicIterationCeiling({
    configuredMaxIterations: 8,
    observations: [],
    budgetSnapshot: {
      mode: "normal",
      remainingMs: 400_000,
      elapsedMs: 20_000,
      remainingTimeRatio: 0.9,
      toolCallsRemaining: 20,
      toolCallRatio: 0.9,
      plannerCallsRemaining: 5,
      plannerCallRatio: 0.83,
      llmCallsRemaining: 30,
      llmCallRatio: 0.83
    },
    requestedLeadCount: 20,
    currentLeadCount: 0,
    diminishingThreshold: 2
  });

  assert.equal(ceiling, 6);
});

test("dynamic iteration ceiling constrains exploration in emergency mode", () => {
  const ceiling = budgetGuardrailsForTests.computeDynamicIterationCeiling({
    configuredMaxIterations: 8,
    observations: [],
    budgetSnapshot: {
      mode: "emergency",
      remainingMs: 120_000,
      elapsedMs: 240_000,
      remainingTimeRatio: 0.33,
      toolCallsRemaining: 8,
      toolCallRatio: 0.4,
      plannerCallsRemaining: 1,
      plannerCallRatio: 0.16,
      llmCallsRemaining: 6,
      llmCallRatio: 0.2
    },
    requestedLeadCount: 20,
    currentLeadCount: 2,
    diminishingThreshold: 2
  });

  assert.equal(ceiling, 3);
});
