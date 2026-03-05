import test from "node:test";
import assert from "node:assert/strict";
import { budgetModesForTests } from "../../src/core/runLeadAgenticLoop.js";

test("budget mode enters conserve and emergency with hysteresis thresholds", () => {
  assert.equal(budgetModesForTests.chooseBudgetMode("normal", 0.7), "normal");
  assert.equal(budgetModesForTests.chooseBudgetMode("normal", 0.44), "conserve");
  assert.equal(budgetModesForTests.chooseBudgetMode("conserve", 0.19), "emergency");
  assert.equal(budgetModesForTests.chooseBudgetMode("emergency", 0.31), "conserve");
  assert.equal(budgetModesForTests.chooseBudgetMode("conserve", 0.61), "normal");
});

test("budget snapshot reports remaining ratios and counts", () => {
  const snapshot = budgetModesForTests.buildBudgetSnapshot({
    mode: "conserve",
    remainingMs: 90_000,
    elapsedMs: 150_000,
    maxDurationMs: 300_000,
    toolCallsUsed: 6,
    maxToolCalls: 12,
    plannerCallsUsed: 2,
    plannerMaxCalls: 6,
    llmCallsUsed: 8,
    llmCallBudget: 20
  });

  assert.equal(snapshot.mode, "conserve");
  assert.equal(snapshot.remainingTimeRatio, 0.3);
  assert.equal(snapshot.toolCallsRemaining, 6);
  assert.equal(snapshot.toolCallRatio, 0.5);
  assert.equal(snapshot.plannerCallsRemaining, 4);
  assert.equal(snapshot.plannerCallRatio, 2 / 3);
  assert.equal(snapshot.llmCallsRemaining, 12);
  assert.equal(snapshot.llmCallRatio, 0.6);
});
