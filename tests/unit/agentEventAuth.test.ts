import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeAgentEvent,
  isLoopbackAddress
} from "../../src/agentEvents/auth.js";

test("isLoopbackAddress accepts IPv4/IPv6 loopback and localhost", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("localhost"), true);
});

test("isLoopbackAddress rejects remote and unknown addresses", () => {
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(""), false);
});

test("authorizeAgentEvent requires the configured token when one is set", () => {
  const args = { remoteAddress: "10.0.0.5", configuredToken: "secret-token" };

  assert.equal(authorizeAgentEvent({ ...args, providedToken: "secret-token" }), true);
  assert.equal(authorizeAgentEvent({ ...args, providedToken: "wrong" }), false);
  assert.equal(authorizeAgentEvent({ ...args, providedToken: undefined }), false);
  // Loopback does NOT bypass a configured token.
  assert.equal(
    authorizeAgentEvent({
      remoteAddress: "127.0.0.1",
      providedToken: undefined,
      configuredToken: "secret-token"
    }),
    false
  );
});

test("authorizeAgentEvent falls back to loopback-only when no token is configured", () => {
  const args = { providedToken: undefined, configuredToken: undefined };

  assert.equal(authorizeAgentEvent({ ...args, remoteAddress: "127.0.0.1" }), true);
  assert.equal(authorizeAgentEvent({ ...args, remoteAddress: "::1" }), true);
  assert.equal(authorizeAgentEvent({ ...args, remoteAddress: "10.0.0.5" }), false);
  assert.equal(authorizeAgentEvent({ ...args, remoteAddress: undefined }), false);
});
