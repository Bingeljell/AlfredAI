import test from "node:test";
import assert from "node:assert/strict";
import { parseRequestedLeadCount } from "../../src/tools/lead/requestIntent.js";

test("parses direct count with filler words", () => {
  assert.equal(parseRequestedLeadCount("Find me 20 MSP and SI companies from USA"), 20);
});

test("parses count near leads keyword", () => {
  assert.equal(parseRequestedLeadCount("Need 35 quality leads for US MSP outreach"), 35);
});

test("falls back to default when no count specified", () => {
  assert.equal(parseRequestedLeadCount("Find MSP companies from USA"), 50);
});

test("applies lower and upper clamps", () => {
  assert.equal(parseRequestedLeadCount("find me 2 leads"), 10);
  assert.equal(parseRequestedLeadCount("find me 400 leads"), 100);
});
