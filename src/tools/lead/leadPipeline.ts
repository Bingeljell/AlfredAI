import type { LeadCandidate, SearchResult } from "../../types.js";
import { scrapeLeadCandidatesWithCheerio } from "../scrape/cheerioExtractor.js";
import { scrapeLeadCandidatesWithPlaywright } from "../scrape/playwrightExtractor.js";

interface LeadPipelineOptions {
  fastScrapeCount: number;
  enablePlaywright: boolean;
  targetLeadCount: number;
  requestMessage: string;
}

function dedupeCandidates(candidates: LeadCandidate[]): LeadCandidate[] {
  const map = new Map<string, LeadCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.companyName.toLowerCase()}|${(candidate.email ?? "").toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, candidate);
      continue;
    }

    map.set(key, {
      ...existing,
      email: existing.email ?? candidate.email,
      emailConfidence: Math.max(existing.emailConfidence, candidate.emailConfidence),
      sourceUrls: Array.from(new Set([...existing.sourceUrls, ...candidate.sourceUrls]))
    });
  }
  return Array.from(map.values());
}

function scoreCandidate(candidate: LeadCandidate): number {
  const sourceCountScore = Math.min(candidate.sourceUrls.length * 0.1, 0.3);
  const emailScore = candidate.email ? 0.25 : 0;
  return candidate.emailConfidence + sourceCountScore + emailScore;
}

export async function buildLeadCandidates(
  searchResults: SearchResult[],
  options: LeadPipelineOptions
): Promise<LeadCandidate[]> {
  const fastTargets = searchResults.slice(0, options.fastScrapeCount);
  const fastCandidates = await scrapeLeadCandidatesWithCheerio(fastTargets, options.requestMessage);

  let combined = [...fastCandidates];

  if (options.enablePlaywright && combined.length < Math.ceil(options.targetLeadCount * 0.35)) {
    const enrichmentTargets = searchResults.slice(options.fastScrapeCount, options.fastScrapeCount + 5);
    const enriched = await scrapeLeadCandidatesWithPlaywright(enrichmentTargets);
    combined = [...combined, ...enriched];
  }

  return dedupeCandidates(combined)
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, Math.min(100, Math.max(10, options.targetLeadCount)));
}
