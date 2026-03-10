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
    const mergedUrls = dedupeUrls([...requestedUrls, ...searchUrls]).slice(0, maxPages);
    if (mergedUrls.length === 0) {
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
      const collection = await browserPool.collectPages(mergedUrls, browseConcurrency, context.deadlineAtMs);
      context.setFetchedPages(collection.pages);

      return {
        query: input.query ?? null,
        searchProvider: searchProvider ?? null,
        searchFallbackUsed: searchFallbackUsed ?? null,
        requestedUrlCount: requestedUrls.length,
        urlCount: mergedUrls.length,
        pagesFetched: collection.pages.length,
        browseFailureCount: collection.failures.length,
        browseFailureSamples: collection.failures.slice(0, 8),
        storedPageCount: context.getFetchedPages().length,
        samplePages: collection.pages.slice(0, 3).map((page) => ({
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
