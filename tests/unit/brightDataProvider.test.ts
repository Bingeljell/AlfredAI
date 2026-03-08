import test from "node:test";
import assert from "node:assert/strict";
import { BrightDataProvider } from "../../src/tools/search/providers/brightDataProvider.js";

test("bright data provider healthcheck reflects key presence", async () => {
  const providerWithKey = new BrightDataProvider({
    apiKey: "test-key",
    baseUrl: "https://api.brightdata.com",
    searchPath: "/request",
    zone: "test-zone",
    engine: "duckduckgo",
    country: "us",
    timeoutMs: 3000
  });
  const providerWithoutKey = new BrightDataProvider({
    apiKey: "",
    baseUrl: "https://api.brightdata.com",
    searchPath: "/request",
    zone: "test-zone",
    engine: "duckduckgo",
    country: "us",
    timeoutMs: 3000
  });
  const providerWithoutZone = new BrightDataProvider({
    apiKey: "test-key",
    baseUrl: "https://api.brightdata.com",
    searchPath: "/request",
    zone: "",
    engine: "duckduckgo",
    country: "us",
    timeoutMs: 3000
  });

  assert.equal(await providerWithKey.healthcheck(), true);
  assert.equal(await providerWithoutKey.healthcheck(), false);
  assert.equal(await providerWithoutZone.healthcheck(), false);
});

test("bright data provider normalizes organic_results payload", async (t) => {
  const provider = new BrightDataProvider({
    apiKey: "test-key",
    baseUrl: "https://api.brightdata.com",
    searchPath: "/request",
    zone: "test-zone",
    engine: "duckduckgo",
    country: "us",
    timeoutMs: 3000
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.method, "POST");
    const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    assert.equal(requestBody.zone, "test-zone");
    assert.equal(requestBody.format, "json");
    assert.equal(requestBody.method, "GET");
    assert.match(String(requestBody.url ?? ""), /^https:\/\/duckduckgo.com\/\?q=/);
    return {
      ok: true,
      json: async () => ({
        organic_results: [
          { title: "Result One", link: "https://example.com/1", snippet: "One" },
          { title: "Result Two", link: "https://example.com/2", snippet: "Two" }
        ]
      })
    } as Response;
  }) as typeof fetch;

  const results = await provider.search("msp usa", 5);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.provider, "brightdata");
  assert.equal(results[0]?.url, "https://example.com/1");
});

test("bright data provider includes status and body snippet on non-ok response", async (t) => {
  const provider = new BrightDataProvider({
    apiKey: "test-key",
    baseUrl: "https://api.brightdata.com",
    searchPath: "/request",
    zone: "test-zone",
    engine: "duckduckgo",
    country: "us",
    timeoutMs: 3000
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 429,
      text: async () => "rate limited by provider"
    }) as Response) as typeof fetch;

  await assert.rejects(
    () => provider.search("msp usa", 5),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /status 429/);
      assert.match(error.message, /rate limited by provider/);
      return true;
    }
  );
});

test("bright data provider parses nested JSON body payload", async (t) => {
  const provider = new BrightDataProvider({
    apiKey: "test-key",
    baseUrl: "https://api.brightdata.com",
    searchPath: "/request",
    zone: "test-zone",
    engine: "duckduckgo",
    country: "us",
    timeoutMs: 3000
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        body: JSON.stringify({
          results: [{ title: "Nested", url: "https://example.com/nested", description: "nested desc" }]
        })
      })
    }) as Response) as typeof fetch;

  const results = await provider.search("msp usa", 5);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.url, "https://example.com/nested");
});
