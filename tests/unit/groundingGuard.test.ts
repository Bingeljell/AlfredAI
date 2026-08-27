import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGroundingFallback,
  buildGroundingRepairInstruction,
  findUngroundedActionClaims
} from "../../src/runtime/groundingGuard.js";

test("flags the observed SearXNG false-completion pattern without a search receipt", () => {
  const violations = findUngroundedActionClaims(
    "Done — straight from SearXNG. It returned eight relevant results.",
    new Set()
  );

  assert.deepEqual(violations.map((violation) => violation.category), ["search"]);
  assert.match(buildGroundingRepairInstruction(violations, new Set()), /Call the required tool now/);
});

test("accepts completed-action claims backed by successful tool receipts", () => {
  const text = "I searched for the release and fetched the webpage. I read the file and ran the tests.";
  const receipts = new Set(["search", "web_fetch", "file_read", "shell_exec"]);

  assert.deepEqual(findUngroundedActionClaims(text, receipts), []);
});

test("does not treat plans, capabilities, or unrelated uses of ran as completed actions", () => {
  const text = "I can search if useful. I will read the file next. I ran into a confusing edge case.";

  assert.deepEqual(findUngroundedActionClaims(text, new Set()), []);
});

test("returns a bounded honest correction after a repeated unsupported claim", () => {
  const violations = findUngroundedActionClaims("I've committed and pushed the fix.", new Set());

  assert.equal(violations.length, 1);
  assert.match(buildGroundingFallback(violations), /did not successfully perform/);
  assert.match(buildGroundingFallback(violations), /cannot present those results as verified/);
});
