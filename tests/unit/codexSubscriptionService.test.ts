import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexSubscriptionService } from "../../src/provider/codex/subscriptionService.js";

class FakeSubscriptionClient {
  readonly notifications = new EventEmitter();
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
    if (method === "account/rateLimits/read") return { rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 }, secondary: null, rateLimitReachedType: null, credits: { balance: null, hasCredits: false, unlimited: true } }, rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 }, rateLimitReachedType: null } } } as T;
    return { summary: { lifetimeTokens: 1234, peakDailyTokens: 500, currentStreakDays: 2, longestStreakDays: 4, longestRunningTurnSec: 10 }, dailyUsageBuckets: [{ startDate: "2026-09-01", tokens: 321 }] } as T;
  }

  subscribeNotifications(listener: (notification: { method: string; params?: unknown }) => void): () => void {
    this.notifications.on("notification", listener);
    return () => this.notifications.off("notification", listener);
  }

  emit(notification: { method: string; params?: unknown }): void {
    this.notifications.emit("notification", notification);
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

test("subscription service keeps a redacted short-lived rate-limit snapshot and applies updates", async () => {
  const client = new FakeSubscriptionClient();
  const service = new CodexSubscriptionService(client, async () => undefined, { rateLimitCacheTtlMs: 1_000 });
  const first = await service.readRateLimits();
  assert.equal(first.primary?.usedPercent, 42);
  assert.equal(first.buckets?.codex?.limitId, "codex");
  assert.equal(client.requests.filter((method) => method === "account/rateLimits/read").length, 1);

  client.emit({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", limitName: "rolling", primary: { usedPercent: 100, resetsAt: 1_800_000_000, rateLimitReachedType: "primary" } } } });
  const updated = await service.readRateLimits();
  assert.equal(updated.limitName, "rolling");
  assert.equal(updated.primary?.usedPercent, 100);
  assert.equal(updated.primary?.resetsAt, 1_800_000_000);

  const forced = await service.readRateLimits(true);
  assert.equal(forced.primary?.usedPercent, 42);
  assert.equal(JSON.stringify(updated).includes("accessToken"), false);
});
