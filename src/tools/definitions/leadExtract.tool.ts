import { z } from "zod";
import type { LeadAgentToolDefinition } from "../types.js";
import { extractLeadsFromPagePayloads } from "../lead/subReactPipeline.js";
import { LeadPipelineFiltersSchema, normalizeLeadPipelineFilters } from "../lead/filters.js";

export const LeadExtractToolInputSchema = z.object({
  requestMessage: z.string().min(1).max(500).optional(),
  extractionBatchSize: z.number().int().min(1).max(6).optional(),
  llmMaxCalls: z.number().int().min(1).max(20).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  filters: LeadPipelineFiltersSchema.optional()
});

export const toolDefinition: LeadAgentToolDefinition<typeof LeadExtractToolInputSchema> = {
  name: "lead_extract",
  description: "Extract structured leads from already-fetched pages stored in the current agent state.",
  inputSchema: LeadExtractToolInputSchema,
  inputHint: "Use after web_fetch when you want an atomic fetch -> extract flow instead of the full lead_pipeline.",
  async execute(input, context) {
    const pages = context.getFetchedPages();
    if (pages.length === 0) {
      return {
        storedPageCount: 0,
        extractedLeadCount: 0,
        addedLeadCount: 0,
        totalLeadCount: context.state.leads.length,
        extractionFailureCount: 0,
        extractionFailureSamples: [],
        stoppedEarlyReason: "no_fetched_pages"
      };
    }

    const normalizedFilters = normalizeLeadPipelineFilters(input.filters);
    const outcome = await extractLeadsFromPagePayloads({
      pages,
      message: input.requestMessage ?? context.message,
      openAiApiKey: context.openAiApiKey,
      extractionBatchSize: input.extractionBatchSize ?? context.defaults.subReactBatchSize,
      llmMaxCalls: input.llmMaxCalls ?? context.defaults.subReactLlmMaxCalls,
      minConfidence: input.minConfidence ?? context.defaults.subReactMinConfidence,
      requestedLeadCount: context.state.requestedLeadCount,
      executionBrief: context.leadExecutionBrief,
      filters: normalizedFilters,
      deadlineAtMs: context.deadlineAtMs,
      isCancellationRequested: context.isCancellationRequested
    });

    const merged = context.addLeads(outcome.leads);
    return {
      storedPageCount: pages.length,
      extractedLeadCount: outcome.finalCandidateCount,
      addedLeadCount: merged.addedCount,
      totalLeadCount: merged.totalCount,
      rawCandidateCount: outcome.rawCandidateCount,
      finalCandidateCount: outcome.finalCandidateCount,
      deficitCount: outcome.deficitCount,
      extractionFailureCount: outcome.extractionFailureCount,
      extractionFailureSamples: outcome.extractionFailureSamples,
      llmCallsUsed: outcome.llmCallsUsed,
      llmCallsRemaining: outcome.llmCallsRemaining,
      llmUsage: outcome.llmUsage,
      stoppedEarlyReason: outcome.stoppedEarlyReason
    };
  }
};
