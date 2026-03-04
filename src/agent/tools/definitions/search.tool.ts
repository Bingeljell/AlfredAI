import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";

export const SearchToolInputSchema = z.object({
  query: z.string().min(2).max(400),
  maxResults: z.number().int().min(1).max(15).optional()
});

export const toolDefinition: LeadAgentToolDefinition<typeof SearchToolInputSchema> = {
  name: "search",
  description: "Run provider-backed web search and return top results.",
  inputSchema: SearchToolInputSchema,
  inputHint: "Use to test/expand discovery queries before running deeper lead extraction.",
  async execute(input, context) {
    const response = await context.searchManager.search(input.query, input.maxResults ?? context.defaults.searchMaxResults);

    return {
      provider: response.provider,
      fallbackUsed: response.fallbackUsed,
      resultCount: response.results.length,
      topResults: response.results.slice(0, 5).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        rank: item.rank
      }))
    };
  }
};
