import test from "node:test";
import assert from "node:assert/strict";
import { closeCodexProviderResources } from "../../src/gateway/providerShutdown.js";

test("provider shutdown closes subscription before account resources and hides close errors", async () => {
  const calls: string[] = [];
  await closeCodexProviderResources({
    subscriptionService: {
      async close() {
        calls.push("subscription");
        throw new Error("account@example.com token=secret");
      }
    },
    accountService: {
      async close() {
        calls.push("account");
      }
    }
  });

  assert.deepEqual(calls, ["subscription", "account"]);
});
