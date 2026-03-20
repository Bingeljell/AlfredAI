import { z } from "zod";
import type { ToolDefinition } from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export const RecoverSearchToolInputSchema = z.object({
  reason: z.string().min(1).max(200).optional()
});

export const toolDefinition: ToolDefinition<typeof RecoverSearchToolInputSchema> = {
  name: "recover_search",
  description: "Attempt recovery of the primary search provider (for example restarting local SearXNG).",
  inputSchema: RecoverSearchToolInputSchema,
  inputHint: "Use when search provider appears down; then re-check status and retry search/lead_pipeline.",
  async execute(input, context) {
    const statusBefore = await context.searchManager.getProviderStatus();
    const recovery = await context.searchManager.recoverPrimary();
    const statusAfter = await context.searchManager.getProviderStatus();

    await context.runStore.appendEvent({
      runId: context.runId,
      sessionId: context.sessionId,
      phase: "tool",
      eventType: "search_recovery",
      payload: {
        reason: input.reason ?? "agent_requested",
        statusBefore,
        recovery,
        statusAfter
      },
      timestamp: nowIso()
    });

    return {
      reason: input.reason ?? "agent_requested",
      statusBefore,
      recovery,
      statusAfter
    };
  }
};
