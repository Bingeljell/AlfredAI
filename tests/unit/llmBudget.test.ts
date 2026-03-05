import test from "node:test";
import assert from "node:assert/strict";
import { LlmBudgetManager } from "../../src/tools/lead/llmBudget.js";

test("LlmBudgetManager enforces hard cap", () => {
  const budget = new LlmBudgetManager(2);
  assert.equal(budget.consume(), true);
  assert.equal(budget.consume(), true);
  assert.equal(budget.consume(), false);
  assert.equal(budget.used, 2);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.limit, 2);
});
