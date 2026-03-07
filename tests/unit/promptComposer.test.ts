import test from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt } from "../../src/prompts/composePrompt.js";

test("composeSystemPrompt builds labeled blocks and skips empty sections", () => {
  const composed = composeSystemPrompt([
    { label: "Persona", content: "You are Alfred." },
    { label: "Domain", content: "Lead generation." },
    { label: "Empty", content: "   " }
  ]);

  assert.match(composed, /\[Persona\]/);
  assert.match(composed, /\[Domain\]/);
  assert.doesNotMatch(composed, /\[Empty\]/);
});
