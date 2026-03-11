import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyStructuredFailure,
  computeRetryDelayMs,
  isRetryableHttpStatus,
  parseRetryAfterMs
} from "../../src/core/reliability.js";

test("classifyStructuredFailure maps policy and schema failures", () => {
  assert.equal(classifyStructuredFailure({ failureCode: "http_error", statusCode: 401 }), "policy_block");
  assert.equal(classifyStructuredFailure({ failureCode: "json_parse_error" }), "schema");
  assert.equal(classifyStructuredFailure({ failureCode: "zod_validation_error" }), "schema");
  assert.equal(classifyStructuredFailure({ failureCode: "network_error", failureMessage: "socket closed" }), "network");
  assert.equal(classifyStructuredFailure({ failureCode: "network_error", failureMessage: "Request timed out" }), "timeout");
});

test("retry helpers parse retry-after and compute bounded delay", () => {
  const retryAfterMs = parseRetryAfterMs("2");
  assert.equal(retryAfterMs, 2000);

  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(404), false);

  const delayMs = computeRetryDelayMs(
    2,
    {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 500,
      jitterRatio: 0
    },
    retryAfterMs
  );
  assert.equal(delayMs, 500);
});
