import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";

export const SearchStatusToolInputSchema = z.object({});

export const toolDefinition: LeadAgentToolDefinition<typeof SearchStatusToolInputSchema> = {
  name: "search_status",
  description: "Check live health of search providers and whether primary recovery is available.",
  inputSchema: SearchStatusToolInputSchema,
  inputHint: "Use when search-yield is low or search failures indicate provider outages/timeouts.",
  async execute(_input, context) {
    const status = await context.searchManager.getProviderStatus();
    return {
      primaryProvider: status.primaryProvider,
      fallbackProvider: status.fallbackProvider,
      primaryHealthy: status.primaryHealthy,
      fallbackHealthy: status.fallbackHealthy,
      primaryRecoverySupported: status.primaryRecoverySupported,
      activeDefault: status.activeDefault,
      lastPrimaryHealthyAt: status.lastPrimaryHealthyAt,
      consecutivePrimaryFailures: status.consecutivePrimaryFailures,
      lastPrimaryFailure: status.lastPrimaryFailure
    };
  }
};
