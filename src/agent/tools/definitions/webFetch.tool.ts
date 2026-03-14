import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";
import { BrowserPool } from "../../../tools/lead/browserPool.js";
import { SearchManagerError } from "../../../tools/search/searchManager.js";

export const WebFetchToolInputSchema = z
  .object({
    query: z.string().min(2).max(400).optional(),
    urls: z.array(z.string().url()).max(30).optional(),
    useStoredUrls: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(15).optional(),
    maxPages: z.number().int().min(1).max(25).optional(),
    browseConcurrency: z.number().int().min(1).max(6).optional()
  })
  .refine((value) => Boolean(value.query || value.useStoredUrls || (value.urls && value.urls.length > 0)), {
    message: "Provide query, stored urls, or explicit urls"
  });

function dedupeUrls(urls: string[]): string[] {
  return Array.from(
    new Set(
      urls
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

interface FetchedPageQuality {
  url: string;
  title: string;
  textLength: number;
  usable: boolean;
  signals: string[];
}

const BLOCKING_PATTERNS = [
  /\bare you a robot\b/i,
  /\bcaptcha\b/i,
  /\bx-forbidden\b/i,
  /\baccess denied\b/i,
  /\bforbidden\b/i,
  /\bcloudflare\b/i,
  /\bverify you are human\b/i,
  /\bsubscribe to continue\b/i,
  /\bsign in to continue\b/i,
  /\b404\b/i,
  /\bnot found\b/i
];

export function evaluateFetchedPageQuality(page: { url: string; title: string; text: string }): FetchedPageQuality {
  const normalizedTitle = (page.title || "").trim();
  const normalizedText = (page.text || "").replace(/\s+/g, " ").trim();
  const textLength = normalizedText.length;
  const signals: string[] = [];
  const composite = `${normalizedTitle} ${normalizedText.slice(0, 800)}`.trim();

  if (textLength < 220) {
    signals.push("low_text");
  }
  if (!normalizedTitle && textLength < 600) {
    signals.push("missing_title");
  }
  for (const pattern of BLOCKING_PATTERNS) {
    if (pattern.test(composite)) {
      signals.push("blocked_or_paywalled");
      break;
    }
  }

  const usable = !signals.includes("blocked_or_paywalled") && textLength >= 220;
  return {
    url: page.url,
    title: normalizedTitle,
    textLength,
    usable,
    signals
  };
}

export function selectFetchedPagesForStorage<TPage extends { url: string; title: string; text: string }>(
  pages: TPage[],
  maxPages: number
): {
  selectedPages: TPage[];
  quality: FetchedPageQuality[];
  usableCount: number;
  degradedCount: number;
} {
  const quality = pages.map((page) => evaluateFetchedPageQuality(page));
  const usableUrls = new Set(quality.filter((item) => item.usable).map((item) => item.url));
  const usablePages = pages.filter((page) => usableUrls.has(page.url));
  const selectedPages =
    usablePages.length > 0
      ? usablePages.slice(0, maxPages)
      : pages.slice(0, maxPages);
  return {
    selectedPages,
    quality,
    usableCount: usablePages.length,
    degradedCount: Math.max(0, quality.length - usablePages.length)
  };
}

export const toolDefinition: LeadAgentToolDefinition<typeof WebFetchToolInputSchema> = {
  name: "web_fetch",
  description: "Fetch and parse web pages using browser automation from query results or explicit URL list.",
  inputSchema: WebFetchToolInputSchema,
  inputHint: "Use for deterministic page retrieval before extraction. Prefer maxPages <= 12 unless necessary.",
  async execute(input, context) {
    const maxPages = input.maxPages ?? 10;
    const browseConcurrency = input.browseConcurrency ?? context.defaults.subReactBrowseConcurrency;
    const maxResults = input.maxResults ?? context.defaults.searchMaxResults;

    let searchProvider: string | undefined;
    let searchFallbackUsed: boolean | undefined;
    let searchFailureCount = 0;
    const searchFailureSamples: Array<{ query: string; error: string; stage?: string; provider?: string; transient?: boolean }> = [];
    let searchUrls: string[] = [];

    if (input.query) {
      try {
        const response = await context.searchManager.search(input.query, maxResults);
        searchProvider = response.provider;
        searchFallbackUsed = response.fallbackUsed;
        searchUrls = response.results.map((item) => item.url);
      } catch (error) {
        searchFailureCount = 1;
        if (error instanceof SearchManagerError) {
          searchFailureSamples.push({
            query: input.query,
            error: error.message.slice(0, 220),
            stage: error.diagnostic.stage,
            provider: error.diagnostic.provider,
            transient: error.diagnostic.transient
          });
        } else {
          searchFailureSamples.push({
            query: input.query,
            error: error instanceof Error ? error.message.slice(0, 220) : String(error).slice(0, 220)
          });
        }
      }
    }

    const storedUrls = input.useStoredUrls ? (context.getShortlistedUrls?.() ?? []) : [];
    const requestedUrls = [...(input.urls ?? []), ...storedUrls];
    const candidateUrls = dedupeUrls([...requestedUrls, ...searchUrls]);
    const primaryUrls = candidateUrls.slice(0, maxPages);
    if (primaryUrls.length === 0) {
      context.setFetchedPages([]);
      return {
        query: input.query ?? null,
        searchProvider: searchProvider ?? null,
        searchFallbackUsed: searchFallbackUsed ?? null,
        requestedUrlCount: requestedUrls.length,
        urlCount: 0,
        pagesFetched: 0,
        browseFailureCount: 0,
        browseFailureSamples: [],
        searchFailureCount,
        searchFailureSamples
      };
    }

    const browserPool = await BrowserPool.create();
    try {
      const primaryCollection = await browserPool.collectPages(primaryUrls, browseConcurrency, context.deadlineAtMs);
      let allPages = [...primaryCollection.pages];
      let allFailures = [...primaryCollection.failures];
      const primarySelection = selectFetchedPagesForStorage(primaryCollection.pages, maxPages);
      const remainingCandidateUrls = candidateUrls.slice(primaryUrls.length);
      const retryUrlCount = primarySelection.degradedCount > 0
        ? Math.min(primarySelection.degradedCount, remainingCandidateUrls.length, maxPages)
        : 0;

      let retryPagesFetched = 0;
      if (retryUrlCount > 0) {
        const retryUrls = remainingCandidateUrls.slice(0, retryUrlCount);
        const retryCollection = await browserPool.collectPages(retryUrls, browseConcurrency, context.deadlineAtMs);
        retryPagesFetched = retryCollection.pages.length;
        allPages = [...allPages, ...retryCollection.pages];
        allFailures = [...allFailures, ...retryCollection.failures];
      }

      const selection = selectFetchedPagesForStorage(allPages, maxPages);
      context.setFetchedPages(selection.selectedPages);

      return {
        query: input.query ?? null,
        searchProvider: searchProvider ?? null,
        searchFallbackUsed: searchFallbackUsed ?? null,
        requestedUrlCount: requestedUrls.length,
        urlCount: primaryUrls.length,
        pagesFetched: selection.selectedPages.length,
        rawPagesFetched: allPages.length,
        usablePageCount: selection.usableCount,
        degradedPageCount: selection.degradedCount,
        retryUrlCount,
        retryPagesFetched,
        browseFailureCount: allFailures.length,
        browseFailureSamples: allFailures.slice(0, 8),
        degradedPageSamples: selection.quality
          .filter((item) => !item.usable)
          .slice(0, 8)
          .map((item) => ({
            url: item.url,
            title: item.title,
            textLength: item.textLength,
            signals: item.signals
          })),
        storedPageCount: context.getFetchedPages().length,
        samplePages: selection.selectedPages.slice(0, 3).map((page) => ({
          url: page.url,
          title: page.title,
          textPreview: page.text.slice(0, 220)
        })),
        searchFailureCount,
        searchFailureSamples
      };
    } finally {
      await browserPool.close();
    }
  }
};
