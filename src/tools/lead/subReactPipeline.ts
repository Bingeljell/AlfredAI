import type { LeadCandidate, SearchResult } from "../../types.js";
import type { RunStore } from "../../runs/runStore.js";
import type { SearchManager } from "../search/searchManager.js";
import {
  runOpenAiStructuredChat,
  runOpenAiStructuredChatWithDiagnostics,
  type StructuredChatDiagnostic,
  type StructuredChatHttpErrorDetails
} from "../../services/openAiClient.js";
import { BrowserPool, type PagePayload } from "./browserPool.js";
import { ExtractedLeadBatchSchema, QueryExpansionSchema, type ExtractedLead } from "./schemas.js";
import { LlmBudgetManager } from "./llmBudget.js";
import { parseRequestedLeadCount } from "./requestIntent.js";

const QUERY_EXPANSION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    queries: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string" }
    },
    targetLeadCount: {
      type: "integer",
      minimum: 10,
      maximum: 100
    }
  },
  required: ["queries"]
} as const;

const EXTRACTED_LEAD_BATCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          companyName: { type: "string" },
          website: { type: "string" },
          location: { type: "string" },
          shortDesc: { type: "string" },
          sourceUrl: { type: "string" },
          confidence: { type: "number" },
          evidence: { type: "string" }
        },
        required: ["companyName", "shortDesc", "sourceUrl", "confidence", "evidence"]
      }
    }
  },
  required: ["leads"]
} as const;

interface LeadSubReactOptions {
  runId: string;
  sessionId: string;
  message: string;
  runStore: RunStore;
  searchManager: SearchManager;
  openAiApiKey?: string;
  searchMaxResults: number;
  maxPages: number;
  browseConcurrency: number;
  extractionBatchSize: number;
  llmMaxCalls: number;
  minConfidence: number;
}

export interface LeadSubReactResult {
  leads: LeadCandidate[];
  llmCallsUsed: number;
  llmCallsRemaining: number;
  requestedLeadCount: number;
  rawCandidateCount: number;
  validatedCandidateCount: number;
  finalCandidateCount: number;
  queryCount: number;
  pagesVisited: number;
  deficitCount: number;
}

interface QueryPlanResult {
  queries: string[];
  targetLeadCount?: number;
  plannerFailureReason?: string;
  plannerFailureDetails?: StructuredChatHttpErrorDetails;
  usedModelPlan: boolean;
}

interface ExtractBatchResult {
  leads: LeadCandidate[];
  attemptsUsed: number;
  failureReasons: string[];
  failureDetails: Array<Record<string, unknown>>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseLocationHint(message: string): string | undefined {
  const match = message.match(/\bin\s+([A-Za-z][A-Za-z\s]{1,40})$/i);
  return match?.[1]?.trim();
}

function fallbackQueryExpansion(message: string): string[] {
  const location = parseLocationHint(message) ?? "USA";
  const lower = message.toLowerCase();
  const base = new Set<string>();
  base.add(`top managed service providers ${location} 2026`);
  base.add(`best system integrator companies ${location}`);
  base.add(`msp companies list site:clutch.co ${location}`);
  if (/si|system integrator/.test(lower)) {
    base.add(`system integrator directory ${location}`);
  }
  if (/msp|managed service/.test(lower)) {
    base.add(`managed service provider directory ${location}`);
  }
  return Array.from(base).slice(0, 5);
}

function normalizeWebsite(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeDomain(url: string | undefined): string {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeCandidate(item: ExtractedLead): LeadCandidate {
  return {
    companyName: item.companyName.replace(/\s+/g, " ").trim(),
    website: normalizeWebsite(item.website),
    location: item.location?.replace(/\s+/g, " ").trim(),
    shortDesc: item.shortDesc.replace(/\s+/g, " ").trim(),
    sourceUrl: item.sourceUrl,
    confidence: Math.min(1, Math.max(0, item.confidence)),
    evidence: item.evidence.replace(/\s+/g, " ").trim()
  };
}

function dedupeLeads(leads: LeadCandidate[]): LeadCandidate[] {
  const map = new Map<string, LeadCandidate>();

  for (const lead of leads) {
    const key = normalizeDomain(lead.website || lead.sourceUrl) || lead.companyName.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, lead);
      continue;
    }

    if (lead.confidence > existing.confidence) {
      map.set(key, lead);
    }
  }

  return Array.from(map.values());
}

function scoreLead(lead: LeadCandidate): number {
  const completeness = [lead.website, lead.location, lead.shortDesc, lead.evidence].filter(Boolean).length / 4;
  const citationBonus = lead.evidence.length > 30 ? 0.05 : 0;
  return Math.min(1, lead.confidence * 0.75 + completeness * 0.2 + citationBonus);
}

function qualityGate(leads: LeadCandidate[], requestedLeadCount: number, minConfidence: number): LeadSubReactResult {
  const minFinal = 15;
  const maxFinal = Math.min(25, requestedLeadCount);

  const deduped = dedupeLeads(leads)
    .map((lead) => ({ ...lead, confidence: scoreLead(lead) }))
    .sort((a, b) => b.confidence - a.confidence);

  const validated = deduped.filter((lead) => lead.confidence >= minConfidence);
  const finalLeads = validated.slice(0, Math.max(minFinal, maxFinal));

  return {
    leads: finalLeads,
    llmCallsUsed: 0,
    llmCallsRemaining: 0,
    requestedLeadCount,
    rawCandidateCount: leads.length,
    validatedCandidateCount: validated.length,
    finalCandidateCount: finalLeads.length,
    queryCount: 0,
    pagesVisited: 0,
    deficitCount: Math.max(0, requestedLeadCount - finalLeads.length)
  };
}

async function emitStep(
  runStore: RunStore,
  runId: string,
  sessionId: string,
  step: "query_expansion" | "browse_batch" | "extraction" | "quality_gate",
  payload: Record<string, unknown>
): Promise<void> {
  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "sub_react_step",
    eventType: "sub_react_step",
    payload: { step, ...payload },
    timestamp: nowIso()
  });
}

function formatDiagnosticReason(diagnostic: StructuredChatDiagnostic<unknown>): string {
  const code = diagnostic.failureCode ?? "unknown";
  const message = diagnostic.failureMessage?.slice(0, 220);
  return message ? `${code}: ${message}` : code;
}

function diagnosticDetails(diagnostic: StructuredChatDiagnostic<unknown>, attempt: number): Record<string, unknown> {
  return {
    attempt,
    failureCode: diagnostic.failureCode ?? "unknown",
    failureMessage: diagnostic.failureMessage?.slice(0, 220),
    statusCode: diagnostic.statusCode,
    ...(diagnostic.httpErrorDetails ? { httpErrorDetails: diagnostic.httpErrorDetails } : {})
  };
}

async function buildQueryPlan(message: string, options: LeadSubReactOptions, budget: LlmBudgetManager): Promise<QueryPlanResult> {
  if (!options.openAiApiKey || !budget.consume()) {
    return {
      queries: fallbackQueryExpansion(message),
      usedModelPlan: false,
      plannerFailureReason: !options.openAiApiKey ? "missing_api_key" : "llm_budget_exhausted"
    };
  }

  const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
    {
      apiKey: options.openAiApiKey,
      schemaName: "lead_query_expansion",
      jsonSchema: QUERY_EXPANSION_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content:
            "Rewrite user lead requests into 3-5 targeted search queries for discovering real company entities. Include vertical+location intent and directory-style queries. Also output a targetLeadCount integer when the user intent specifies quantity."
        },
        { role: "user", content: message }
      ]
    },
    QueryExpansionSchema
  );

  if (!diagnostic.result) {
    return {
      queries: fallbackQueryExpansion(message),
      usedModelPlan: false,
      plannerFailureReason: formatDiagnosticReason(diagnostic),
      plannerFailureDetails: diagnostic.httpErrorDetails
    };
  }

  return {
    queries: diagnostic.result.queries.map((query) => query.trim()).filter(Boolean).slice(0, 5),
    targetLeadCount: diagnostic.result.targetLeadCount,
    usedModelPlan: true
  };
}

function mergeSearchResults(searchResults: SearchResult[][], maxPages: number): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  for (const batch of searchResults) {
    for (const item of batch) {
      if (!unique.has(item.url)) {
        unique.set(item.url, { ...item, rank: unique.size + 1 });
      }
    }
  }

  return Array.from(unique.values()).slice(0, maxPages);
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    output.push(items.slice(i, i + size));
  }
  return output;
}

function buildExtractionPrompt(batch: PagePayload[], requestMessage: string): string {
  return [
    "You are an expert B2B lead researcher.",
    "Extract REAL companies matching the request (SI/MSP context where relevant).",
    "Never output the aggregator/listing site itself as a company lead.",
    "Return strict JSON only.",
    "Use confidence 0-1.",
    `User request: ${requestMessage}`,
    "Page payloads:",
    JSON.stringify(batch)
  ].join("\n");
}

async function extractBatch(
  batch: PagePayload[],
  options: LeadSubReactOptions,
  budget: LlmBudgetManager
): Promise<ExtractBatchResult> {
  const failureReasons: string[] = [];
  const failureDetails: Array<Record<string, unknown>> = [];

  if (!options.openAiApiKey) {
    return {
      leads: [],
      attemptsUsed: 0,
      failureReasons: ["missing_api_key"],
      failureDetails: [{ attempt: 0, failureCode: "missing_api_key", failureMessage: "OpenAI API key is not configured" }]
    };
  }

  if (!budget.consume()) {
    return {
      leads: [],
      attemptsUsed: 0,
      failureReasons: ["llm_budget_exhausted_before_first_attempt"],
      failureDetails: [
        {
          attempt: 0,
          failureCode: "llm_budget_exhausted",
          failureMessage: "LLM budget exhausted before first extraction attempt"
        }
      ]
    };
  }

  let attemptsUsed = 1;
  const firstAttempt = await runOpenAiStructuredChatWithDiagnostics(
    {
      apiKey: options.openAiApiKey,
      schemaName: "lead_extraction_batch",
      jsonSchema: EXTRACTED_LEAD_BATCH_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content:
            "Extract company leads as strict JSON. Output only real company entities (not aggregator/list host)."
        },
        {
          role: "user",
          content: buildExtractionPrompt(batch, options.message)
        }
      ]
    },
    ExtractedLeadBatchSchema
  );

  if (firstAttempt.result) {
    return {
      leads: firstAttempt.result.leads.map(normalizeCandidate),
      attemptsUsed,
      failureReasons,
      failureDetails
    };
  }

  failureReasons.push(`attempt_1:${formatDiagnosticReason(firstAttempt)}`);
  failureDetails.push(diagnosticDetails(firstAttempt, 1));

  if (!budget.consume()) {
    failureReasons.push("retry_skipped:llm_budget_exhausted");
    failureDetails.push({
      attempt: attemptsUsed + 1,
      failureCode: "llm_budget_exhausted",
      failureMessage: "Retry skipped because LLM budget was exhausted"
    });
    return {
      leads: [],
      attemptsUsed,
      failureReasons,
      failureDetails
    };
  }

  attemptsUsed = 2;
  const retryBatch = batch.map((item) => ({
    url: item.url,
    title: item.title,
    listItems: item.listItems.slice(0, 40),
    tableRows: item.tableRows.slice(0, 40),
    outboundLinks: item.outboundLinks.slice(0, 40),
    text: item.text.slice(0, 2500)
  }));

  const retryAttempt = await runOpenAiStructuredChatWithDiagnostics(
    {
      apiKey: options.openAiApiKey,
      schemaName: "lead_extraction_batch_retry",
      jsonSchema: EXTRACTED_LEAD_BATCH_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content:
            "Retry extraction. Keep only real company entities, strict schema output, omit uncertain entities."
        },
        {
          role: "user",
          content: buildExtractionPrompt(retryBatch, options.message)
        }
      ]
    },
    ExtractedLeadBatchSchema
  );

  if (retryAttempt.result) {
    return {
      leads: retryAttempt.result.leads.map(normalizeCandidate),
      attemptsUsed,
      failureReasons,
      failureDetails
    };
  }

  failureReasons.push(`attempt_2:${formatDiagnosticReason(retryAttempt)}`);
  failureDetails.push(diagnosticDetails(retryAttempt, 2));
  return {
    leads: [],
    attemptsUsed,
    failureReasons,
    failureDetails
  };
}

export async function executeLeadSubReactPipeline(options: LeadSubReactOptions): Promise<LeadSubReactResult> {
  const budget = new LlmBudgetManager(options.llmMaxCalls);
  const fallbackRequestedLeadCount = parseRequestedLeadCount(options.message);

  await emitStep(options.runStore, options.runId, options.sessionId, "query_expansion", {
    status: "started",
    fallbackRequestedLeadCount,
    llmCallsUsed: budget.used,
    llmCallsRemaining: budget.remaining
  });

  const queryPlan = await buildQueryPlan(options.message, options, budget);
  const requestedLeadCount = queryPlan.targetLeadCount ?? fallbackRequestedLeadCount;

  await emitStep(options.runStore, options.runId, options.sessionId, "query_expansion", {
    status: "completed",
    queryCount: queryPlan.queries.length,
    requestedLeadCount,
    requestedLeadCountSource: queryPlan.targetLeadCount ? "model_plan" : "fallback_parser",
    usedModelPlan: queryPlan.usedModelPlan,
    plannerFailureReason: queryPlan.plannerFailureReason,
    plannerFailureDetails: queryPlan.plannerFailureDetails,
    llmCallsUsed: budget.used,
    llmCallsRemaining: budget.remaining
  });

  const searchOutputs = await Promise.all(
    queryPlan.queries.map((query) => options.searchManager.search(query, options.searchMaxResults).catch(() => undefined))
  );
  const mergedResults = mergeSearchResults(
    searchOutputs.filter(Boolean).map((item) => item!.results),
    options.maxPages
  );

  await emitStep(options.runStore, options.runId, options.sessionId, "browse_batch", {
    status: "started",
    urlCount: mergedResults.length
  });

  const browserPool = await BrowserPool.create();
  let pagePayloads: PagePayload[] = [];
  try {
    pagePayloads = await browserPool.collectPages(
      mergedResults.map((item) => item.url),
      options.browseConcurrency
    );
  } finally {
    await browserPool.close();
  }

  await emitStep(options.runStore, options.runId, options.sessionId, "browse_batch", {
    status: "completed",
    urlCount: mergedResults.length,
    pagesVisited: pagePayloads.length
  });

  const batches = chunk(pagePayloads, options.extractionBatchSize);
  const extractedLeads: LeadCandidate[] = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    await emitStep(options.runStore, options.runId, options.sessionId, "extraction", {
      status: "started",
      batchIndex: index + 1,
      totalBatches: batches.length,
      llmCallsUsed: budget.used,
      llmCallsRemaining: budget.remaining
    });

    const extraction = await extractBatch(batch, options, budget);
    extractedLeads.push(...extraction.leads);

    await emitStep(options.runStore, options.runId, options.sessionId, "extraction", {
      status: "completed",
      batchIndex: index + 1,
      totalBatches: batches.length,
      extractedCount: extraction.leads.length,
      attemptsUsed: extraction.attemptsUsed,
      failureReasons: extraction.failureReasons,
      failureDetails: extraction.failureDetails,
      llmCallsUsed: budget.used,
      llmCallsRemaining: budget.remaining
    });
  }

  await emitStep(options.runStore, options.runId, options.sessionId, "quality_gate", {
    status: "started",
    rawCandidateCount: extractedLeads.length
  });

  const gated = qualityGate(extractedLeads, requestedLeadCount, options.minConfidence);
  gated.queryCount = queryPlan.queries.length;
  gated.pagesVisited = pagePayloads.length;
  gated.llmCallsUsed = budget.used;
  gated.llmCallsRemaining = budget.remaining;

  await emitStep(options.runStore, options.runId, options.sessionId, "quality_gate", {
    status: "completed",
    requestedLeadCount,
    rawCandidateCount: gated.rawCandidateCount,
    validatedCandidateCount: gated.validatedCandidateCount,
    finalCandidateCount: gated.finalCandidateCount,
    deficitCount: gated.deficitCount,
    llmCallsUsed: gated.llmCallsUsed,
    llmCallsRemaining: gated.llmCallsRemaining
  });

  return gated;
}
