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

test("redactValue masks OAuth fields, bearer values, and embedded JWTs", () => {
  const jwt = "eyJhbGciOiJub25lIn0.eyJhY2Nlc3MiOiJjYW5hcnkifQ.signature-canary";
  const output = redactValue({
    accessToken: "access-canary",
    refresh_token: "refresh-canary",
    accountId: "account-canary",
    authorization: "Bearer bearer-canary",
    prose: `OAuth response ${jwt}`
  }) as any;
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes("access-canary"), false);
  assert.equal(serialized.includes("refresh-canary"), false);
  assert.equal(serialized.includes("account-canary"), false);
  assert.equal(serialized.includes("bearer-canary"), false);
  assert.equal(serialized.includes(jwt), false);
});
