import test from "node:test";
import assert from "node:assert/strict";
import { scrapeLeadCandidatesWithCheerio } from "../../src/tools/scrape/cheerioExtractor.js";

const originalFetch = global.fetch;

test("cheerio extractor prefers company entries from list-style pages", async (t) => {
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = (async () => {
    const html = `
      <html>
        <head><title>Top Managed Service Providers in USA</title></head>
        <body>
          <h1>Top Managed Service Providers in USA</h1>
          <h2>1. Acme Tech Solutions</h2>
          <h2>2. Northstar Systems</h2>
          <ul>
            <li><a href="https://acmetech.com">Acme Tech Solutions</a></li>
            <li><a href="https://northstar.io">Northstar Systems</a></li>
            <li><a href="https://linkedin.com/company/example">LinkedIn Profile</a></li>
          </ul>
        </body>
      </html>
    `;

    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const leads = await scrapeLeadCandidatesWithCheerio(
    [
      {
        title: "Top Managed Service Providers in USA",
        url: "https://example-directory.com/top-msp",
        snippet: "",
        provider: "searxng",
        rank: 1
      }
    ],
    "Find 50 SI and MSP leads in USA"
  );

  assert.ok(leads.some((lead) => lead.companyName === "Acme Tech Solutions"));
  assert.ok(leads.some((lead) => lead.companyName === "Northstar Systems"));
  assert.ok(!leads.some((lead) => /Top Managed Service Providers/i.test(lead.companyName)));
});
