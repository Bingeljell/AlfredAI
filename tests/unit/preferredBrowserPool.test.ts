import test from "node:test";
import assert from "node:assert/strict";
import type { PageCollectionResult, PageCollector } from "../../src/tools/browser/browserPool.js";
import { PreferredBrowserPool } from "../../src/tools/browser/preferredBrowserPool.js";

class FakeCollector implements PageCollector {
  closed = false;
  calls = 0;

  constructor(private readonly result: PageCollectionResult) {}

  async collectPages(): Promise<PageCollectionResult> {
    this.calls += 1;
    return this.result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function page(url: string) {
  return {
    url,
    title: "Example",
    text: "Useful content",
    tableRows: [],
    listItems: [],
    outboundLinks: []
  };
}

test("PreferredBrowserPool uses healthy Pinchtab without creating Playwright", async () => {
  const pinchtab = Object.assign(new FakeCollector({ pages: [page("https://example.com")], failures: [] }), {
    health: async () => true
  });
  let playwrightCreates = 0;
  const pool = new PreferredBrowserPool({
    pinchtabBaseUrl: "http://127.0.0.1:9867",
    enablePlaywright: true,
    createPinchtab: () => pinchtab,
    createPlaywright: async () => {
      playwrightCreates += 1;
      return new FakeCollector({ pages: [], failures: [] });
    }
  });

  const result = await pool.collectPages(["https://example.com"], 1);

  assert.equal(result.pages.length, 1);
  assert.equal(pool.backend, "pinchtab");
  assert.equal(pool.browserFallbackReason, undefined);
  assert.equal(playwrightCreates, 0);
});

test("PreferredBrowserPool falls back when Pinchtab is unhealthy", async () => {
  const pinchtab = Object.assign(new FakeCollector({ pages: [], failures: [] }), {
    health: async () => false
  });
  const playwright = new FakeCollector({ pages: [page("https://example.com")], failures: [] });
  const pool = new PreferredBrowserPool({
    pinchtabBaseUrl: "http://127.0.0.1:9867",
    enablePlaywright: true,
    createPinchtab: () => pinchtab,
    createPlaywright: async () => playwright
  });

  const result = await pool.collectPages(["https://example.com"], 1);

  assert.equal(result.pages.length, 1);
  assert.equal(pool.backend, "playwright");
  assert.equal(pool.browserFallbackReason, "pinchtab_unhealthy");
  assert.equal(pinchtab.calls, 0);
  assert.equal(playwright.calls, 1);
});

test("PreferredBrowserPool falls back after a Pinchtab collection failure", async () => {
  const pinchtab = Object.assign(new FakeCollector({
    pages: [],
    failures: [{ url: "https://example.com", error: "connection reset" }]
  }), { health: async () => true });
  const playwright = new FakeCollector({ pages: [page("https://example.com")], failures: [] });
  const pool = new PreferredBrowserPool({
    pinchtabBaseUrl: "http://127.0.0.1:9867",
    enablePlaywright: true,
    createPinchtab: () => pinchtab,
    createPlaywright: async () => playwright
  });

  const result = await pool.collectPages(["https://example.com"], 1);

  assert.equal(result.pages.length, 1);
  assert.equal(pool.backend, "playwright");
  assert.match(pool.browserFallbackReason ?? "", /pinchtab_failed: connection reset/);
  assert.equal(pinchtab.closed, true);
});

test("PreferredBrowserPool fails clearly when no fallback is permitted", async () => {
  const pinchtab = Object.assign(new FakeCollector({ pages: [], failures: [] }), {
    health: async () => false
  });
  const pool = new PreferredBrowserPool({
    pinchtabBaseUrl: "http://127.0.0.1:9867",
    enablePlaywright: false,
    createPinchtab: () => pinchtab
  });

  await assert.rejects(
    pool.collectPages(["https://example.com"], 1),
    /Playwright fallback is disabled/
  );
});
