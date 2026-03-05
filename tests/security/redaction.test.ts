import test from "node:test";
import assert from "node:assert/strict";
import { redactValue } from "../../src/utils/redact.js";

test("redactValue masks keys and inline API keys", () => {
  const input = {
    token: "abc123",
    nested: {
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456",
      description: "normal"
    }
  };

  const output = redactValue(input) as any;
  assert.equal(output.token, "[REDACTED]");
  assert.equal(output.nested.apiKey, "[REDACTED]");
  assert.equal(output.nested.description, "normal");
});
