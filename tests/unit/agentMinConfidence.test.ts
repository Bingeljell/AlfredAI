import test from "node:test";
import assert from "node:assert/strict";
import { determineAdaptiveMinConfidence } from "../../src/core/runLeadAgenticLoop.js";

test("adaptive minConfidence starts strict, then relaxes on high deficit after iteration 2", () => {
  assert.equal(determineAdaptiveMinConfidence(1, 20, 0), 0.7);
  assert.equal(determineAdaptiveMinConfidence(2, 20, 0), 0.65);
  assert.equal(determineAdaptiveMinConfidence(3, 20, 5), 0.6);
});

test("adaptive minConfidence stays at 0.65 when late-iteration deficit is not high", () => {
  assert.equal(determineAdaptiveMinConfidence(4, 20, 16), 0.65);
});
