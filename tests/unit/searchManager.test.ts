import test from "node:test";
import assert from "node:assert/strict";
import { SearchManager } from "../../src/tools/search/searchManager.js";
import type { SearchProvider } from "../../src/tools/search/types.js";

class FakeProvider implements SearchProvider {
  constructor(
    public readonly name: "searxng" | "brave",
    private readonly healthy: boolean,
    private readonly items: number
  ) {}

  async healthcheck(): Promise<boolean> {
    return this.healthy;
  }

  async search(query: string, maxResults: number) {
    return Array.from({ length: Math.min(this.items, maxResults) }).map((_, index) => ({
      title: `${query}-${index}`,
      url: `https://example.com/${index}`,
      snippet: "",
      provider: this.name,
      rank: index + 1
    }));
  }
}

test("search manager enforces max 15 result cap", async () => {
  const manager = new SearchManager({
    primary: new FakeProvider("searxng", true, 50),
    fallback: new FakeProvider("brave", true, 50),
    maxResults: 15,
    startupTimeoutMs: 1,
    retryIntervalMs: 1
  });

  const output = await manager.search("fintech leads", 100);
  assert.equal(output.results.length, 15);
  assert.equal(output.provider, "searxng");
});

test("search manager falls back when primary is unhealthy", async () => {
  const manager = new SearchManager({
    primary: new FakeProvider("searxng", false, 0),
    fallback: new FakeProvider("brave", true, 3),
    maxResults: 15,
    startupTimeoutMs: 1,
    retryIntervalMs: 1
  });

  const output = await manager.search("fintech leads");
  assert.equal(output.provider, "brave");
  assert.equal(output.fallbackUsed, true);
  assert.equal(output.results.length, 3);
});
