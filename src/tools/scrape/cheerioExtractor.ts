import * as cheerio from "cheerio";
import type { LeadCandidate, SearchResult } from "../../types.js";

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const GENERIC_TERMS = [
  "top",
  "best",
  "managed service providers",
  "it service companies",
  "learn more",
  "read more",
  "privacy policy",
  "cookie policy",
  "table of contents",
  "home",
  "contact us",
  "blog",
  "news"
];
const SOCIAL_DOMAINS = ["linkedin.com", "facebook.com", "twitter.com", "x.com", "youtube.com", "instagram.com"];

function normalizeCompanyName(input: string): string {
  return input
    .replace(/^\s*\d+\s*[\.\):\-]\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[|–—].*$/, "")
    .trim();
}

function pickBestEmail(candidates: string[]): string | undefined {
  const preferred = candidates.find((value) => !value.includes("noreply"));
  return preferred ?? candidates[0];
}

function extractHostName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hostToCompanyName(host: string): string {
  const main = host.split(".")[0] ?? host;
  return main
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .trim();
}

function isLikelyCompanyName(name: string): boolean {
  if (!name) {
    return false;
  }
  if (name.length < 2 || name.length > 80) {
    return false;
  }
  if (!/[A-Za-z]/.test(name)) {
    return false;
  }
  if (name.split(" ").length > 8) {
    return false;
  }
  const lower = name.toLowerCase();
  if (GENERIC_TERMS.some((term) => lower.includes(term))) {
    return false;
  }
  if (/\bin (the )?(usa|us|united states)\b/i.test(name)) {
    return false;
  }
  if (/^(the|our|your)\b/i.test(name)) {
    return false;
  }
  if (/^\W+$/.test(name)) {
    return false;
  }
  return true;
}

function inferRoleFromRequest(requestMessage: string): string | undefined {
  const lower = requestMessage.toLowerCase();
  if (/\bmsp\b/.test(lower) && (/\bsi\b/.test(lower) || /system integrator/.test(lower))) {
    return "MSP/SI";
  }
  if (/\bmsp\b|managed service/.test(lower)) {
    return "MSP";
  }
  if (/\bsi\b|system integrator/.test(lower)) {
    return "SI";
  }
  return undefined;
}

function inferLocationFromRequest(requestMessage: string): string | undefined {
  const match = requestMessage.match(/\bin\s+([A-Za-z][A-Za-z\s]{1,40})$/i);
  return match?.[1]?.trim();
}

function collectListBasedNames($: cheerio.CheerioAPI): string[] {
  const names = new Set<string>();
  const selectors = ["h2", "h3", "h4", "li", "td:first-child"];
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const raw = $(element).text();
      const normalized = normalizeCompanyName(raw);
      if (!isLikelyCompanyName(normalized)) {
        return;
      }
      names.add(normalized);
    });
  }
  return Array.from(names);
}

function collectAnchorCandidates($: cheerio.CheerioAPI, sourceUrl: string): Array<{ name: string; href: string }> {
  const sourceHost = extractHostName(sourceUrl);
  const output: Array<{ name: string; href: string }> = [];

  $("a[href]").each((_, element) => {
    const rawHref = $(element).attr("href");
    if (!rawHref) {
      return;
    }
    const text = normalizeCompanyName($(element).text());
    const href = (() => {
      try {
        return new URL(rawHref, sourceUrl).toString();
      } catch {
        return "";
      }
    })();
    if (!href.startsWith("http")) {
      return;
    }
    const host = extractHostName(href);
    if (!host || SOCIAL_DOMAINS.some((domain) => host.includes(domain))) {
      return;
    }
    const sameHost = host === sourceHost;
    const candidateName = isLikelyCompanyName(text) ? text : hostToCompanyName(host);
    if (!isLikelyCompanyName(candidateName)) {
      return;
    }
    if (sameHost && !/\/company|\/profile|\/partner|\/directory/i.test(href)) {
      return;
    }
    output.push({ name: candidateName, href });
  });

  return output;
}

function buildFallbackCandidate(result: SearchResult, role: string | undefined, location: string | undefined): LeadCandidate | undefined {
  const companyName = normalizeCompanyName(result.title);
  if (!isLikelyCompanyName(companyName)) {
    return undefined;
  }
  return {
    companyName,
    role,
    location,
    emailConfidence: 0.2,
    sourceUrls: [result.url],
    notes: "Fallback from search result title"
  };
}

export async function scrapeLeadCandidatesWithCheerio(
  results: SearchResult[],
  requestMessage: string
): Promise<LeadCandidate[]> {
  const candidates: LeadCandidate[] = [];
  const role = inferRoleFromRequest(requestMessage);
  const location = inferLocationFromRequest(requestMessage);

  for (const result of results) {
    try {
      const response = await fetch(result.url, {
        signal: AbortSignal.timeout(10000),
        headers: {
          "User-Agent": "AlfredLeadAgent/0.1"
        }
      });
      if (!response.ok) {
        continue;
      }
      const html = await response.text();
      const $ = cheerio.load(html);

      const textSlice = $("body").text().replace(/\s+/g, " ").slice(0, 5000);
      const emails = Array.from(new Set(textSlice.match(EMAIL_REGEX) ?? []));
      const email = pickBestEmail(emails);

      const anchorCandidates = collectAnchorCandidates($, result.url).slice(0, 20);
      const listNames = collectListBasedNames($).slice(0, 30);
      const pageCandidates = new Map<string, LeadCandidate>();

      for (const item of anchorCandidates) {
        pageCandidates.set(item.name.toLowerCase(), {
          companyName: item.name,
          role,
          location,
          emailConfidence: 0.5,
          sourceUrls: [result.url, item.href],
          notes: "Extracted from linked directory/list entry"
        });
      }

      for (const name of listNames) {
        const key = name.toLowerCase();
        const existing = pageCandidates.get(key);
        if (existing) {
          pageCandidates.set(key, {
            ...existing,
            emailConfidence: Math.max(existing.emailConfidence, 0.55)
          });
          continue;
        }
        pageCandidates.set(key, {
          companyName: name,
          role,
          location,
          emailConfidence: 0.4,
          sourceUrls: [result.url],
          notes: "Extracted from page headings/list rows"
        });
      }

      if (pageCandidates.size === 0) {
        const fallback = buildFallbackCandidate(result, role, location);
        if (fallback) {
          pageCandidates.set(fallback.companyName.toLowerCase(), fallback);
        }
      }

      const pageList = Array.from(pageCandidates.values()).slice(0, 25);
      if (email && pageList.length > 0) {
        pageList[0] = {
          ...pageList[0],
          email: pageList[0]?.email ?? email,
          emailConfidence: Math.max(pageList[0]?.emailConfidence ?? 0.3, 0.65),
          notes: `${pageList[0]?.notes ?? "Extracted candidate"} | page email detected`
        };
      }

      candidates.push(...pageList);
    } catch {
      continue;
    }
  }

  return candidates;
}
