import test from "node:test";
import assert from "node:assert/strict";
import { CodexSubscriptionService } from "../../src/provider/codex/subscriptionService.js";

class FakeSubscriptionClient {
  requests: string[] = [];
  async initialize(): Promise<Record<string, unknown>> {
    return {};
  }

  async request<T>(method: string): Promise<T> {
    this.requests.push(method);
    if (method === "model/list") return {
      data: [{ id: "gpt-live", model: "gpt-live", displayName: "GPT Live", description: "live", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "quick" }, { reasoningEffort: "medium", description: "balanced" }], inputModalities: ["text"] }],
      nextCursor: null
    } as T;
    if (method === "modelProvider/capabilities/read") return { imageGeneration: false, namespaceTools: true, webSearch: true } as T;
    if (method === "account/rateLimits/read") return { rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 }, secondary: null, rateLimitReachedType: null, credits: { balance: null, hasCredits: false, unlimited: true } } } as T;
    return { summary: { lifetimeTokens: 1234, peakDailyTokens: 500, currentStreakDays: 2, longestStreakDays: 4, longestRunningTurnSec: 10 }, dailyUsageBuckets: [{ startDate: "2026-09-01", tokens: 321 }] } as T;
  }
}

test("subscription service reads live models, capabilities, quota, and usage without credential fields", async () => {
  const client = new FakeSubscriptionClient();
  const service = new CodexSubscriptionService(client, async () => undefined);
  const catalog = await service.readCatalog();
  assert.equal(catalog.models[0]?.id, "gpt-live");
  assert.deepEqual(catalog.capabilities, { imageGeneration: false, namespaceTools: true, webSearch: true });
  const usage = await service.readUsage();
  assert.equal(usage.rateLimits.primary?.usedPercent, 42);
  assert.equal(usage.usage.summary.lifetimeTokens, 1234);
  assert.equal(JSON.stringify({ catalog, usage }).includes("accessToken"), false);
  assert.equal(JSON.stringify({ catalog, usage }).includes("refreshToken"), false);
});

test("subscription service validates model and reasoning choices against the live catalog", async () => {
  const service = new CodexSubscriptionService(new FakeSubscriptionClient(), async () => undefined);
  assert.equal((await service.validateSelection("gpt-live", "low")).id, "gpt-live");
  await assert.rejects(service.validateSelection("missing"), /not available/);
  await assert.rejects(service.validateSelection("gpt-live", "xhigh"), /not supported/);
});
