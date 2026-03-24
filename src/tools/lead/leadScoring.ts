import type { SearchResult } from "../../types.js";
import type { LeadProfile } from "./leadProfiles.js";
import { getProfileKeywords } from "./leadProfiles.js";

export interface CandidateAssessment {
  normalizedDomain: string;
  homepageUrl: string;
  score: number;
  reasons: string[];
}

const domainBlacklist = [
  "clutch.co",
  "yelp.com",
  "linkedin.com",
  "facebook.com",
  "crunchbase.com",
  "glassdoor.com",
  "upcity.com",
  "designrush.com",
  "cloudtango.org",
  "cloudtango.net",
  "mspdatabase.com",
  "tceq.texas.gov",
  "texas.gov",
  "wikipedia.org",
  "youtube.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "quora.com",
  "business.site",
  "infomsp.com",
  "palisade.email",
  "trgdatacenters.com"
];

const proposalIntentKeywords = [
  "request a quote",
  "get a quote",
  "contact sales",
  "book a consultation",
  "proposal",
  "scope of work",
  "statement of work",
  "estimate"
];

const negativePathHints = [
  "/careers",
  "/jobs",
  "/blog",
  "/news",
  "/wiki",
  "/directory",
  "/list",
  "/top-"
];

export function normalizeDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function toHomepageUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/`;
}

function isLikelyCompanyCandidate(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    if (domainBlacklist.some((blocked) => hostname.includes(blocked))) {
      return false;
    }

    if (hostname.endsWith(".gov") || hostname.endsWith(".edu")) {
      return false;
    }

    return !negativePathHints.some((hint) => path.includes(hint));
  } catch {
    return false;
  }
}

export function assessSearchCandidate(
  result: SearchResult,
  profile: LeadProfile,
  country: string
): CandidateAssessment | null {
  const normalizedDomain = normalizeDomain(result.url);
  if (!normalizedDomain || !isLikelyCompanyCandidate(result.url)) {
    return null;
  }

  const haystack = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  let score = Math.max(0, 5 - result.rank);
  const reasons = [`rank:${result.rank}`];

  for (const keyword of getProfileKeywords(profile)) {
    if (haystack.includes(keyword)) {
      score += 3;
      reasons.push(`profile:${keyword}`);
    }
  }

  for (const keyword of proposalIntentKeywords) {
    if (haystack.includes(keyword)) {
      score += 2;
      reasons.push(`proposal:${keyword}`);
    }
  }

  if ((country.toLowerCase() === "us" || country.toLowerCase() === "usa")
    && (haystack.includes("united states") || haystack.includes("usa"))) {
    score += 2;
    reasons.push("geo:us");
  }

  if (haystack.includes("small business") || haystack.includes("smb")) {
    score += 2;
    reasons.push("size:smb");
  }

  if (haystack.includes("partner") || haystack.includes("certified")) {
    score += 1;
    reasons.push("credibility:partner");
  }

  if (haystack.includes("careers") || haystack.includes("job")) {
    score -= 3;
    reasons.push("negative:jobs");
  }

  if (haystack.includes("top ") || haystack.includes("best ")) {
    score -= 2;
    reasons.push("negative:listicle");
  }

  return {
    normalizedDomain,
    homepageUrl: toHomepageUrl(result.url),
    score,
    reasons
  };
}

export function dedupeAndRankCandidates(
  results: SearchResult[],
  existingDomains: Set<string>,
  profile: LeadProfile,
  country: string
): CandidateAssessment[] {
  const bestByDomain = new Map<string, CandidateAssessment>();

  for (const result of results) {
    const assessment = assessSearchCandidate(result, profile, country);
    if (!assessment || existingDomains.has(assessment.normalizedDomain)) {
      continue;
    }

    const current = bestByDomain.get(assessment.normalizedDomain);
    if (!current || assessment.score > current.score) {
      bestByDomain.set(assessment.normalizedDomain, assessment);
    }
  }

  return Array.from(bestByDomain.values()).sort((a, b) => b.score - a.score);
}
