import { z } from "zod";
import type { LeadAgentToolDefinition } from "../types.js";
import { LeadPipelineFiltersSchema, normalizeLeadPipelineFilters } from "../lead/filters.js";

export const LeadPipelineToolInputSchema = z.object({
  requestMessage: z.string().min(1).max(500).optional(),
  maxPages: z.number().int().min(1).max(25).optional(),
  browseConcurrency: z.number().int().min(1).max(6).optional(),
  extractionBatchSize: z.number().int().min(1).max(6).optional(),
  llmMaxCalls: z.number().int().min(1).max(20).optional(),
  softStopRemainingMs: z.number().int().min(0).max(120_000).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  runEmailEnrichment: z.boolean().optional(),
  filters: LeadPipelineFiltersSchema.optional()
});

export const toolDefinition: LeadAgentToolDefinition<typeof LeadPipelineToolInputSchema> = {
  name: "lead_pipeline",
  description: "Run the lead extraction pipeline over search + browse + extraction + quality gate.",
  inputSchema: LeadPipelineToolInputSchema,
  inputHint:
    "Use when you need more validated leads. Increase maxPages for deeper crawl or tune minConfidence for stricter/looser gating.",
  async execute(input, context) {
    const normalizedFilters = normalizeLeadPipelineFilters(input.filters);
    const outcome = await context.leadPipelineExecutor({
      runId: context.runId,
      sessionId: context.sessionId,
      message: input.requestMessage ?? context.message,
      runStore: context.runStore,
      searchManager: context.searchManager,
      openAiApiKey: context.openAiApiKey,
      searchMaxResults: context.defaults.searchMaxResults,
      maxPages: input.maxPages ?? context.defaults.subReactMaxPages,
      browseConcurrency: input.browseConcurrency ?? context.defaults.subReactBrowseConcurrency,
      extractionBatchSize: input.extractionBatchSize ?? context.defaults.subReactBatchSize,
      llmMaxCalls: input.llmMaxCalls ?? context.defaults.subReactLlmMaxCalls,
      softStopRemainingMs: input.softStopRemainingMs,
      minConfidence: input.minConfidence ?? context.defaults.subReactMinConfidence,
      runEmailEnrichment: input.runEmailEnrichment,
      executionBrief: context.leadExecutionBrief,
      filters: normalizedFilters,
      deadlineAtMs: context.deadlineAtMs,
      isCancellationRequested: context.isCancellationRequested,
      pinchtabBaseUrl: context.defaults.pinchtabBaseUrl
    });

    const merged = context.addLeads(outcome.leads);

    return {
      addedLeadCount: merged.addedCount,
      totalLeadCount: merged.totalCount,
      filtersApplied: normalizedFilters,
      requestedLeadCount: outcome.requestedLeadCount,
      queryCount: outcome.queryCount,
      pagesVisited: outcome.pagesVisited,
      rawCandidateCount: outcome.rawCandidateCount,
      validatedCandidateCount: outcome.validatedCandidateCount,
      finalCandidateCount: outcome.finalCandidateCount,
      deficitCount: outcome.deficitCount,
      llmCallsUsed: outcome.llmCallsUsed,
      llmCallsRemaining: outcome.llmCallsRemaining,
      llmUsage: outcome.llmUsage,
      stoppedEarlyReason: outcome.stoppedEarlyReason,
      sizeRangeRequested: outcome.sizeRangeRequested,
      sizeMatchBreakdown: outcome.sizeMatchBreakdown,
      relaxModeApplied: outcome.relaxModeApplied,
      strictMinConfidence: outcome.strictMinConfidence,
      effectiveMinConfidence: outcome.effectiveMinConfidence,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      searchFailureCount: outcome.searchFailureCount,
      searchFailureSamples: outcome.searchFailureSamples,
      browseFailureCount: outcome.browseFailureCount,
      browseFailureSamples: outcome.browseFailureSamples,
      extractionFailureCount: outcome.extractionFailureCount,
      extractionFailureSamples: outcome.extractionFailureSamples,
      emailLeadCount: outcome.emailLeadCount,
      emailCoverageRatio: outcome.emailCoverageRatio,
      emailEnrichmentAttempted: outcome.emailEnrichmentAttempted,
      emailEnrichmentUpdatedCount: outcome.emailEnrichmentUpdatedCount,
      emailEnrichmentFailureCount: outcome.emailEnrichmentFailureCount,
      emailEnrichmentFailureSamples: outcome.emailEnrichmentFailureSamples,
      emailEnrichmentUrlCap: outcome.emailEnrichmentUrlCap,
      emailEnrichmentQuickScanAttempts: outcome.emailEnrichmentQuickScanAttempts,
      emailEnrichmentQuickScanHits: outcome.emailEnrichmentQuickScanHits,
      emailEnrichmentStoppedEarlyReason: outcome.emailEnrichmentStoppedEarlyReason
    };
  }
};
