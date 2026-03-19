import { z } from "zod";
import type { LeadAgentToolDefinition } from "../types.js";
import { SearchManagerError } from "../search/searchManager.js";
import type { LeadExecutionBrief } from "../lead/schemas.js";
import type { SearchResult } from "../../types.js";

export const LeadSearchShortlistToolInputSchema = z.object({
  query: z.string().min(2).max(400),
  maxResults: z.number().int().min(1).max(15).optional(),
  maxUrls: z.number().int().min(1).max(25).optional()
});

interface RankedSearchResult {
  item: SearchResult;
  score: number;
  reasons: string[];
  hostname: string;
}

interface ShortlistObjectiveHints {
  emailRequired: boolean;
  geographyTokens: string[];
  companyTypeTokens: string[];
}

const HARD_BLOCK_HOSTS = new Set(["youtube.com", "wikipedia.org", "wikidata.org"]);
const NEGATIVE_TEXT_PATTERNS: Array<{ pattern: RegExp; penalty: number; reason: string }> = [
  { pattern: /\bstaffing\b|\brecruit(ment|ing)?\b/, penalty: 18, reason: "staffing_focus" },
  { pattern: /\bglossary\b|\bdefinition\b|\bwhat is\b/, penalty: 14, reason: "definition_content" },
  { pattern: /\bwebinar\b|\bevent\b/, penalty: 10, reason: "event_content" },
  { pattern: /\bhistory\b|\btimeline\b/, penalty: 10, reason: "history_content" },
  { pattern: /\bsitemap\b/, penalty: 9, reason: "sitemap_page" },
  { pattern: /\bjobs?\b|\bcareers?\b/, penalty: 8, reason: "jobs_page" },
  { pattern: /\btop\s*\d+\b|\bbest\s+\d+\b/, penalty: 6, reason: "listicle_content" }
];
const POSITIVE_TEXT_PATTERNS: Array<{ pattern: RegExp; boost: number; reason: string }> = [
  { pattern: /\bmanaged service provider\b|\bmsp\b/, boost: 16, reason: "msp_signal" },
  { pattern: /\bsystems?\s+integrator\b|\bsi\b/, boost: 14, reason: "si_signal" },
  { pattern: /\bmanaged it\b|\bit services\b|\bcloud services\b/, boost: 10, reason: "it_services_signal" },
  { pattern: /\bcontact\b|\babout\b|\bteam\b/, boost: 8, reason: "contactable_page" },
  { pattern: /\bcompany\b|\bofficial site\b/, boost: 4, reason: "company_site_signal" }
];

function tokenizeHint(input: string | undefined | null): string[] {
  if (!input) {
    return [];
  }
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 16);
}

function buildObjectiveHints(brief?: LeadExecutionBrief): ShortlistObjectiveHints {
  return {
    emailRequired: brief?.emailRequired === true,
    geographyTokens: tokenizeHint(brief?.objectiveBrief?.geography),
    companyTypeTokens: tokenizeHint(brief?.objectiveBrief?.companyType)
  };
}

function shouldKeepUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  if (!normalized || normalized.startsWith("mailto:") || normalized.startsWith("tel:")) {
    return false;
  }
  if (/\.(pdf|docx?|xlsx?|pptx?|zip)(?:$|\?)/i.test(normalized)) {
    return false;
  }
  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (hostname.endsWith(".gov") || HARD_BLOCK_HOSTS.has(hostname)) {
      return false;
    }
    if (hostname === "linkedin.com" && /\/(in|posts?|feed)\//.test(parsed.pathname.toLowerCase())) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

function scoreSearchResult(item: SearchResult, hints: ShortlistObjectiveHints): RankedSearchResult | null {
  if (!shouldKeepUrl(item.url)) {
    return null;
  }

  const hostname = extractHostname(item.url);
  const text = `${item.title} ${item.snippet} ${item.url}`.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  for (const signal of POSITIVE_TEXT_PATTERNS) {
    if (signal.pattern.test(text)) {
      score += signal.boost;
      reasons.push(signal.reason);
    }
  }
  for (const signal of NEGATIVE_TEXT_PATTERNS) {
    if (signal.pattern.test(text)) {
      score -= signal.penalty;
      reasons.push(signal.reason);
    }
  }

  if (hostname.endsWith(".fr") || hostname.endsWith(".de") || hostname.endsWith(".uk") || hostname.endsWith(".ca")) {
    score += 2;
    reasons.push("geo_tld_hint");
  }

  if (/\/(contact|about|team|leadership)(\/|$)/.test(item.url.toLowerCase())) {
    score += 7;
    reasons.push("contact_path");
  }
  if (/\/(blog|news|article|resources?)(\/|$)/.test(item.url.toLowerCase())) {
    score -= 4;
    reasons.push("content_page");
  }

  if (hints.emailRequired) {
    if (/\bemail\b|\bcontact us\b|\breach us\b/.test(text)) {
      score += 7;
      reasons.push("email_signal");
    } else {
      score -= 2;
      reasons.push("missing_email_signal");
    }
  }

  if (hints.geographyTokens.length > 0) {
    const matches = hints.geographyTokens.filter((token) => text.includes(token)).length;
    if (matches > 0) {
      score += Math.min(8, matches * 3);
      reasons.push("geo_match");
    } else {
      score -= 3;
      reasons.push("geo_unclear");
    }
  }

  if (hints.companyTypeTokens.length > 0) {
    const matches = hints.companyTypeTokens.filter((token) => text.includes(token)).length;
    if (matches > 0) {
      score += Math.min(8, matches * 2);
      reasons.push("company_type_match");
    }
  }

  return {
    item,
    score,
    reasons: Array.from(new Set(reasons)).slice(0, 6),
    hostname
  };
}

function shortlistByScore(
  ranked: RankedSearchResult[],
  maxUrls: number
): {
  urls: string[];
  diagnostics: Array<{ url: string; score: number; reasons: string[] }>;
} {
  const sorted = [...ranked].sort((a, b) => b.score - a.score || a.item.rank - b.item.rank);
  const selected: string[] = [];
  const diagnostics: Array<{ url: string; score: number; reasons: string[] }> = [];
  const perHost = new Map<string, number>();
  const hostCap = 2;

  for (const candidate of sorted) {
    if (selected.length >= maxUrls) {
      break;
    }
    const used = perHost.get(candidate.hostname) ?? 0;
    if (used >= hostCap) {
      continue;
    }
    selected.push(candidate.item.url);
    diagnostics.push({
      url: candidate.item.url,
      score: candidate.score,
      reasons: candidate.reasons
    });
    perHost.set(candidate.hostname, used + 1);
  }

  return { urls: selected, diagnostics };
}

export const toolDefinition: LeadAgentToolDefinition<typeof LeadSearchShortlistToolInputSchema> = {
  name: "lead_search_shortlist",
  description:
    "Search and keep only fetch-worthy URLs before browsing, with objective-aware scoring (domain/content/geo/email signals) and host diversity.",
  inputSchema: LeadSearchShortlistToolInputSchema,
  inputHint: "Use before web_fetch when you want a lighter search -> shortlist -> fetch -> extract flow.",
  async execute(input, context) {
    try {
      const response = await context.searchManager.search(
        input.query,
        input.maxResults ?? context.defaults.searchMaxResults
      );
      const hints = buildObjectiveHints(context.leadExecutionBrief);
      const ranked = response.results
        .map((item) => scoreSearchResult(item, hints))
        .filter((item): item is RankedSearchResult => item !== null);
      const shortlisted = shortlistByScore(ranked, input.maxUrls ?? 12);
      const shortlistedUrls = shortlisted.urls;

      context.setShortlistedUrls?.(shortlistedUrls);

      return {
        provider: response.provider,
        fallbackUsed: response.fallbackUsed,
        resultCount: response.results.length,
        scoredCount: ranked.length,
        shortlistedCount: shortlistedUrls.length,
        shortlistedUrls,
        shortlistDiagnostics: shortlisted.diagnostics.slice(0, 8),
        storedShortlistedCount: context.getShortlistedUrls?.().length ?? shortlistedUrls.length
      };
    } catch (error) {
      if (error instanceof SearchManagerError) {
        return {
          provider: error.diagnostic.provider ?? null,
          fallbackUsed: null,
          resultCount: 0,
          shortlistedCount: 0,
          shortlistedUrls: [],
          storedShortlistedCount: context.getShortlistedUrls?.().length ?? 0,
          searchFailureCount: 1,
          searchFailureSamples: [
            {
              query: input.query,
              error: error.message.slice(0, 220),
              stage: error.diagnostic.stage,
              provider: error.diagnostic.provider,
              transient: error.diagnostic.transient
            }
          ]
        };
      }
      throw error;
    }
  }
};
