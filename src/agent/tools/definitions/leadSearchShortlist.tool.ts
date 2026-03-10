import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";
import { SearchManagerError } from "../../../tools/search/searchManager.js";

export const LeadSearchShortlistToolInputSchema = z.object({
  query: z.string().min(2).max(400),
  maxResults: z.number().int().min(1).max(15).optional(),
  maxUrls: z.number().int().min(1).max(25).optional()
});

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
    if (hostname.endsWith(".gov")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const toolDefinition: LeadAgentToolDefinition<typeof LeadSearchShortlistToolInputSchema> = {
  name: "lead_search_shortlist",
  description: "Search and keep only fetch-worthy URLs before browsing (drops docs, mailto/tel, and obvious low-yield hosts).",
  inputSchema: LeadSearchShortlistToolInputSchema,
  inputHint: "Use before web_fetch when you want a lighter search -> shortlist -> fetch -> extract flow.",
  async execute(input, context) {
    try {
      const response = await context.searchManager.search(
        input.query,
        input.maxResults ?? context.defaults.searchMaxResults
      );
      const shortlistedUrls = response.results
        .map((item) => item.url)
        .filter(shouldKeepUrl)
        .slice(0, input.maxUrls ?? 12);

      context.setShortlistedUrls?.(shortlistedUrls);

      return {
        provider: response.provider,
        fallbackUsed: response.fallbackUsed,
        resultCount: response.results.length,
        shortlistedCount: shortlistedUrls.length,
        shortlistedUrls,
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
