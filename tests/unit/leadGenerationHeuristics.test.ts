import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeAndRankCandidates,
  normalizeDomain
} from "../../src/tools/lead/leadScoring.js";
import type { SearchResult } from "../../src/types.js";

function searchResult(overrides: Partial<SearchResult>): SearchResult {
  return {
    title: "Managed IT Services for Small Business",
    url: "https://example.com/",
    snippet: "US-based managed services provider for SMB clients.",
    provider: "brave",
    rank: 1,
    ...overrides
  };
}

test("normalizeDomain strips www prefix", () => {
  assert.equal(normalizeDomain("https://www.example.com/contact"), "example.com");
});

test("dedupeAndRankCandidates keeps the strongest candidate per domain", () => {
  const results: SearchResult[] = [
    searchResult({
      url: "https://www.alpha-msp.com/contact",
      rank: 5,
      snippet: "Managed IT support company."
    }),
    searchResult({
      url: "https://alpha-msp.com/",
      rank: 1,
      snippet: "Managed services provider in the USA for small business clients."
    }),
    searchResult({
      url: "https://directory.example.com/top-msps",
      title: "Top MSPs",
      snippet: "Directory of providers."
    })
  ];

  const ranked = dedupeAndRankCandidates(results, new Set(), "msp", "us");

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.normalizedDomain, "alpha-msp.com");
  assert.equal(ranked[0]?.homepageUrl, "https://alpha-msp.com/");
  assert.ok((ranked[0]?.score ?? 0) > 0);
  assert.ok((ranked[0]?.reasons ?? []).some((reason) => reason.startsWith("profile:")));
});

test("dedupeAndRankCandidates excludes existing domains", () => {
  const results: SearchResult[] = [
    searchResult({
      url: "https://existing-si.com/",
      title: "Systems Integrator",
      snippet: "USA systems integrator and consulting team."
    }),
    searchResult({
      url: "https://fresh-si.com/",
      title: "Cloud Systems Integrator",
      snippet: "Consulting and implementation partner in the United States."
    })
  ];

  const ranked = dedupeAndRankCandidates(results, new Set(["existing-si.com"]), "si", "us");

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.normalizedDomain, "fresh-si.com");
});
