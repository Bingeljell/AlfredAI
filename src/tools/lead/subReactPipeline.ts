import type { LeadCandidate, LeadSizeMatch, SearchProviderName, SearchResult } from "../../types.js";
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
import type { NormalizedLeadPipelineFilters } from "./filters.js";

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
      anyOf: [
        {
          type: "integer",
          minimum: 10,
          maximum: 100
        },
        {
          type: "null"
        }
      ]
    }
  },
  required: ["queries", "targetLeadCount"]
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
          email: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          emailEvidence: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          website: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          location: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          employeeSizeText: { type: "string" },
          employeeMin: {
            anyOf: [{ type: "integer" }, { type: "null" }]
          },
          employeeMax: {
            anyOf: [{ type: "integer" }, { type: "null" }]
          },
          sizeEvidence: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          shortDesc: { type: "string" },
          sourceUrl: { type: "string" },
          confidence: { type: "number" },
          evidence: { type: "string" }
        },
        required: [
          "companyName",
          "email",
          "emailEvidence",
          "website",
          "location",
          "employeeSizeText",
          "employeeMin",
          "employeeMax",
          "sizeEvidence",
          "shortDesc",
          "sourceUrl",
          "confidence",
          "evidence"
        ]
      }
    }
  },
  required: ["leads"]
} as const;

const EXTRACTION_SYSTEM_PROMPT = `
You are an expert B2B lead researcher specializing in USA-based System Integrators (SI) and Managed Service Providers (MSP).

Task:
Extract REAL company leads from the provided page payloads (one or more pages may be included).

Hard rules:
- Only return companies that are clearly SI, MSP, or very close IT services providers.
- NEVER return the aggregator, directory, or listing site itself as a lead.
- NEVER use ranking labels (for example "#3 provider") as company names.
- Use ONLY information explicitly visible in the provided page payloads.
- Do NOT invent any data.
- When present on the page, extract business emails from contact sections, footers, and explicit mailto links.

Employee size parsing rules (CRITICAL):
- Always attempt to extract the employee count range from the page.
- Convert the text into two integer fields:
  - employeeMin: lower bound (for example "11-50" -> 11, "under 50" -> 1, "small team" -> null)
  - employeeMax: upper bound (for example "11-50" -> 50, "under 50" -> 50, "201-500" -> 500)
- Additional examples:
  - "50+" -> employeeMin=50, employeeMax=50
  - "~25" or "about 25 employees" -> employeeMin=25, employeeMax=25
- If no employee information is found or it cannot be parsed, set both to null.
- employeeSizeText is required:
  - if size text is found, use the exact snippet (for example "11-50 employees")
  - if not found, set employeeSizeText to "unknown"
- Be conservative: only set numbers when the page clearly states a range or exact number.

Schema contract (strict):
Return ONLY a valid JSON object with this exact structure:
{
  "leads": [
    {
      "companyName": string,
      "email": string | null,
      "emailEvidence": string | null,
      "website": string | null,
      "location": string | null,
      "employeeSizeText": string,
      "employeeMin": number | null,
      "employeeMax": number | null,
      "sizeEvidence": string | null,
      "shortDesc": string,
      "sourceUrl": string,
      "confidence": number,
      "evidence": string
    }
  ]
}

Field rules:
- companyName: exact name as shown on the page.
- email: valid work email only if explicitly present on the page, otherwise null.
- emailEvidence: where the email was found (for example "contact page", "footer", "mailto link", "unknown"), otherwise null.
- website: full valid URL if clearly present, otherwise null.
- location: city + state if mentioned, otherwise null.
- employeeSizeText: raw text from the page (for example "11-50 employees").
- employeeMin / employeeMax: parsed integer bounds or null when unclear.
- sizeEvidence: short note where size info came from (for example "about page", "team section", "provider profile", "unknown").
- shortDesc: one concise sentence, max 25 words.
- sourceUrl: exact page URL this company came from.
- confidence: number from 0.0 to 1.0.
- evidence: 1-2 short sentences explaining why this is a good lead.

If no good leads are found, return { "leads": [] }.

Output requirements:
- Valid JSON only. No markdown, no explanations, no extra keys or text.
- Confidence guidelines:
  - 0.80-1.00 = very strong SI/MSP fit with clear evidence
  - 0.60-0.79 = good fit
  - 0.55-0.59 = near-range or partial fit (allowed)
  - <0.55 = do not include
`;

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
  filters?: NormalizedLeadPipelineFilters;
  isCancellationRequested?: () => Promise<boolean>;
}

export interface LeadSubReactResult {
  leads: LeadCandidate[];
  cancelled: boolean;
  llmCallsUsed: number;
  llmCallsRemaining: number;
  requestedLeadCount: number;
  rawCandidateCount: number;
  validatedCandidateCount: number;
  finalCandidateCount: number;
  queryCount: number;
  pagesVisited: number;
  deficitCount: number;
  sizeRangeRequested?: { min: number; max: number };
  sizeMatchBreakdown: {
    in_range: number;
    near_range: number;
    unknown: number;
    out_of_range: number;
  };
  relaxModeApplied: boolean;
  strictMinConfidence: number;
  effectiveMinConfidence: number;
  relaxedMinConfidence?: number;
  searchFailureCount: number;
  searchFailureSamples: Array<{ query: string; error: string }>;
  browseFailureCount: number;
  browseFailureSamples: Array<{ url: string; error: string }>;
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

interface SearchOutcomeSuccess {
  query: string;
  provider: SearchProviderName;
  fallbackUsed: boolean;
  resultCount: number;
  results: SearchResult[];
}

interface SearchOutcomeFailure {
  query: string;
  error: string;
}

type SearchOutcome = SearchOutcomeSuccess | SearchOutcomeFailure;

interface EmployeeSizeRange {
  min: number;
  max: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseLocationHint(message: string): string | undefined {
  const match = message.match(/\bin\s+([A-Za-z][A-Za-z\s]{1,40})$/i);
  return match?.[1]?.trim();
}

function toPositiveInt(value: number | undefined | null): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.round(value);
  if (normalized <= 0) {
    return undefined;
  }
  return normalized;
}

function parseNumericToken(value: string): number | undefined {
  const numeric = Number(value.replaceAll(",", ""));
  return Number.isFinite(numeric) ? Math.round(numeric) : undefined;
}

function parseEmployeeRangeFromText(text: string | undefined): EmployeeSizeRange | undefined {
  if (!text) {
    return undefined;
  }

  const betweenMatch = text.match(/(\d{1,3}(?:,\d{3})?)\s*(?:-|to|and)\s*(\d{1,3}(?:,\d{3})?)/i);
  if (betweenMatch) {
    const first = parseNumericToken(betweenMatch[1] ?? "");
    const second = parseNumericToken(betweenMatch[2] ?? "");
    if (first && second) {
      return first <= second ? { min: first, max: second } : { min: second, max: first };
    }
  }

  const plusMatch = text.match(/(\d{1,3}(?:,\d{3})?)\s*\+/i);
  if (plusMatch) {
    const value = parseNumericToken(plusMatch[1] ?? "");
    if (value) {
      return { min: value, max: value };
    }
  }

  return undefined;
}

function normalizeEmployeeRange(
  employeeMin: number | undefined | null,
  employeeMax: number | undefined | null,
  employeeSizeText: string | undefined,
  evidence: string
): EmployeeSizeRange | undefined {
  const min = toPositiveInt(employeeMin);
  const max = toPositiveInt(employeeMax);

  if (min && max) {
    return min <= max ? { min, max } : { min: max, max: min };
  }
  if (min) {
    return { min, max: min };
  }
  if (max) {
    return { min: max, max };
  }

  return parseEmployeeRangeFromText(employeeSizeText) ?? parseEmployeeRangeFromText(evidence);
}

function parseTargetEmployeeRange(message: string): EmployeeSizeRange | undefined {
  const patterns = [
    /\bbetween\s+(\d{1,3}(?:,\d{3})?)\s+(?:and|to)\s+(\d{1,3}(?:,\d{3})?)\s+employees?\b/i,
    /\b(\d{1,3}(?:,\d{3})?)\s*(?:-|to)\s*(\d{1,3}(?:,\d{3})?)\s+employees?\b/i,
    /\bemployees?\s*(?:between\s*)?(\d{1,3}(?:,\d{3})?)\s*(?:and|to|-)\s*(\d{1,3}(?:,\d{3})?)\b/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) {
      continue;
    }
    const first = parseNumericToken(match[1] ?? "");
    const second = parseNumericToken(match[2] ?? "");
    if (first && second) {
      return first <= second ? { min: first, max: second } : { min: second, max: first };
    }
  }

  return undefined;
}

function resolveTargetEmployeeRange(
  message: string,
  filters: NormalizedLeadPipelineFilters | undefined
): EmployeeSizeRange | undefined {
  if (filters?.employeeCountMin && filters.employeeCountMax) {
    return {
      min: Math.min(filters.employeeCountMin, filters.employeeCountMax),
      max: Math.max(filters.employeeCountMin, filters.employeeCountMax)
    };
  }

  if (filters?.employeeCountMin) {
    return {
      min: filters.employeeCountMin,
      max: filters.employeeCountMin
    };
  }

  if (filters?.employeeCountMax) {
    return {
      min: 1,
      max: filters.employeeCountMax
    };
  }

  return parseTargetEmployeeRange(message);
}

function fallbackQueryExpansion(message: string, filters: NormalizedLeadPipelineFilters | undefined): string[] {
  const location = filters?.country ?? parseLocationHint(message) ?? "USA";
  const sizeClause = filters?.employeeCountMax ? ` under ${filters.employeeCountMax} employees` : "";
  const lower = message.toLowerCase();
  const base = new Set<string>();
  base.add(`top managed service providers ${location}${sizeClause} 2026`);
  base.add(`best system integrator companies ${location}${sizeClause}`);
  base.add(`msp companies list site:clutch.co ${location}${sizeClause}`);
  if (/si|system integrator/.test(lower)) {
    base.add(`system integrator directory ${location}${sizeClause}`);
  }
  if (/msp|managed service/.test(lower)) {
    base.add(`managed service provider directory ${location}${sizeClause}`);
  }
  if (filters?.requireEmail || /\bemail|emails|contact\b/i.test(message)) {
    base.add(`managed service providers ${location} contact email`);
  }
  if (filters?.industryKeywords?.length) {
    base.add(`${filters.industryKeywords.join(" ")} managed services ${location}${sizeClause}`);
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

function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKeyForLead(lead: LeadCandidate): string {
  const websiteDomain = normalizeDomain(lead.website);
  if (websiteDomain) {
    return `domain:${websiteDomain}`;
  }

  const company = normalizeCompanyName(lead.companyName);
  const location = (lead.location ?? "").toLowerCase().trim();
  return `name:${company}|loc:${location}`;
}

function normalizeEmail(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/^mailto:/i, "").replace(/\s+/g, "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeCandidate(item: ExtractedLead): LeadCandidate {
  const employeeSizeText = item.employeeSizeText.replace(/\s+/g, " ").trim() || "unknown";
  const inferredRange = normalizeEmployeeRange(item.employeeMin, item.employeeMax, employeeSizeText, item.evidence);

  return {
    companyName: item.companyName.replace(/\s+/g, " ").trim(),
    email: normalizeEmail(item.email),
    emailEvidence: item.emailEvidence?.replace(/\s+/g, " ").trim() || undefined,
    website: normalizeWebsite(item.website ?? undefined),
    location: item.location?.replace(/\s+/g, " ").trim(),
    employeeSizeText,
    employeeMin: inferredRange?.min,
    employeeMax: inferredRange?.max,
    sizeEvidence: item.sizeEvidence?.replace(/\s+/g, " ").trim() || undefined,
    shortDesc: item.shortDesc.replace(/\s+/g, " ").trim(),
    sourceUrl: item.sourceUrl,
    confidence: Math.min(1, Math.max(0, item.confidence)),
    evidence: item.evidence.replace(/\s+/g, " ").trim()
  };
}

function dedupeLeads(leads: LeadCandidate[]): LeadCandidate[] {
  const map = new Map<string, LeadCandidate>();

  for (const lead of leads) {
    const key = dedupeKeyForLead(lead);
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

function deriveSizeMatch(lead: LeadCandidate, targetRange: EmployeeSizeRange | undefined): LeadSizeMatch {
  if (!targetRange) {
    return "unknown";
  }

  const employeeMin = lead.employeeMin;
  const employeeMax = lead.employeeMax;
  if (!employeeMin || !employeeMax) {
    return "unknown";
  }

  const overlaps = employeeMin <= targetRange.max && employeeMax >= targetRange.min;
  if (overlaps) {
    return "in_range";
  }

  const gapAbove = employeeMin > targetRange.max ? employeeMin - targetRange.max : 0;
  const gapBelow = employeeMax < targetRange.min ? targetRange.min - employeeMax : 0;
  const gap = Math.max(gapAbove, gapBelow);
  const nearThreshold = Math.max(20, Math.floor((targetRange.max - targetRange.min + 1) * 0.75));
  if (gap > 0 && gap <= nearThreshold) {
    return "near_range";
  }

  return "out_of_range";
}

function scoreLead(lead: LeadCandidate, targetRange: EmployeeSizeRange | undefined): number {
  const completeness = [lead.website, lead.location, lead.shortDesc, lead.evidence].filter(Boolean).length / 4;
  const citationBonus = lead.evidence.length > 30 ? 0.05 : 0;
  const sizeMatch = lead.sizeMatch ?? deriveSizeMatch(lead, targetRange);
  const sizeAdjustment: Record<LeadSizeMatch, number> = {
    in_range: 0.12,
    near_range: 0.03,
    unknown: 0,
    out_of_range: -0.18
  };
  const sizeScoreDelta = targetRange ? sizeAdjustment[sizeMatch] : 0;
  return Math.min(1, Math.max(0, lead.confidence * 0.75 + completeness * 0.2 + citationBonus + sizeScoreDelta));
}

export const leadQualityScoringForTests = {
  deriveSizeMatch,
  scoreLead
};

function qualityGate(
  leads: LeadCandidate[],
  requestedLeadCount: number,
  minConfidence: number,
  targetEmployeeRange: EmployeeSizeRange | undefined
): LeadSubReactResult {
  const minFinal = 15;
  const maxFinal = Math.min(25, requestedLeadCount);

  const deduped: LeadCandidate[] = dedupeLeads(leads)
    .map((lead) => {
      const sizeMatch = deriveSizeMatch(lead, targetEmployeeRange);
      return {
        ...lead,
        sizeMatch,
        confidence: scoreLead({ ...lead, sizeMatch }, targetEmployeeRange),
        selectionMode: "strict" as const
      };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const strictValidated = deduped.filter((lead) => {
    if (lead.confidence < minConfidence) {
      return false;
    }
    if (targetEmployeeRange && lead.sizeMatch === "out_of_range" && lead.confidence < 0.72) {
      return false;
    }
    return true;
  });

  const targetFinalCount = Math.max(minFinal, maxFinal);
  let validated = strictValidated;
  let relaxModeApplied = false;
  let relaxedMinConfidence: number | undefined;
  let finalLeads = strictValidated.slice(0, targetFinalCount);

  if (targetEmployeeRange && strictValidated.length < Math.ceil(requestedLeadCount * 0.5)) {
    const relaxedThreshold = Math.min(minConfidence, 0.55);
    relaxedMinConfidence = relaxedThreshold;
    const relaxedValidated = deduped.filter((lead) => {
      if (lead.confidence < relaxedThreshold) {
        return false;
      }
      if (lead.sizeMatch === "out_of_range" && lead.confidence < 0.75) {
        return false;
      }
      return true;
    });

    if (relaxedValidated.length > strictValidated.length) {
      relaxModeApplied = true;
      validated = relaxedValidated;
      const strictKeys = new Set(strictValidated.map((lead) => dedupeKeyForLead(lead)));
      finalLeads = relaxedValidated.slice(0, targetFinalCount).map((lead): LeadCandidate => {
        const key = dedupeKeyForLead(lead);
        return strictKeys.has(key) ? lead : { ...lead, selectionMode: "relaxed" as const };
      });
    }
  }

  const sizeMatchBreakdown = deduped.reduce(
    (acc, lead) => {
      acc[lead.sizeMatch ?? "unknown"] += 1;
      return acc;
    },
    {
      in_range: 0,
      near_range: 0,
      unknown: 0,
      out_of_range: 0
    }
  );

  return {
    leads: finalLeads,
    cancelled: false,
    llmCallsUsed: 0,
    llmCallsRemaining: 0,
    requestedLeadCount,
    rawCandidateCount: leads.length,
    validatedCandidateCount: validated.length,
    finalCandidateCount: finalLeads.length,
    queryCount: 0,
    pagesVisited: 0,
    deficitCount: Math.max(0, requestedLeadCount - finalLeads.length),
    sizeRangeRequested: targetEmployeeRange,
    sizeMatchBreakdown,
    relaxModeApplied,
    strictMinConfidence: minConfidence,
    effectiveMinConfidence: relaxModeApplied ? (relaxedMinConfidence ?? minConfidence) : minConfidence,
    relaxedMinConfidence,
    searchFailureCount: 0,
    searchFailureSamples: [],
    browseFailureCount: 0,
    browseFailureSamples: []
  };
}

async function isCancelled(options: LeadSubReactOptions): Promise<boolean> {
  if (!options.isCancellationRequested) {
    return false;
  }
  return options.isCancellationRequested();
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
      queries: fallbackQueryExpansion(message, options.filters),
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
            "Rewrite user lead requests into 3-5 targeted search queries for discovering real company entities. Include vertical+location intent and directory-style queries. Respect any explicit filter context (employee-count constraints, country, industry keywords, email intent). Also output a targetLeadCount integer when the user intent specifies quantity."
        },
        { role: "user", content: JSON.stringify({ request: message, filters: options.filters }) }
      ]
    },
    QueryExpansionSchema
  );

  if (!diagnostic.result) {
    return {
      queries: fallbackQueryExpansion(message, options.filters),
      usedModelPlan: false,
      plannerFailureReason: formatDiagnosticReason(diagnostic),
      plannerFailureDetails: diagnostic.httpErrorDetails
    };
  }

  return {
    queries: diagnostic.result.queries.map((query) => query.trim()).filter(Boolean).slice(0, 5),
    targetLeadCount: diagnostic.result.targetLeadCount ?? undefined,
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

function buildExtractionPrompt(
  batch: PagePayload[],
  requestMessage: string,
  filters: NormalizedLeadPipelineFilters | undefined
): string {
  return [
    `User request: ${requestMessage}`,
    `Filters: ${JSON.stringify(filters ?? {})}`,
    "Page payloads (batched):",
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
          content: EXTRACTION_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: buildExtractionPrompt(batch, options.message, options.filters)
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
            `${EXTRACTION_SYSTEM_PROMPT}\n\nRetry context: previous attempt failed validation. Return a strictly schema-valid JSON object.`
        },
        {
          role: "user",
          content: buildExtractionPrompt(retryBatch, options.message, options.filters)
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
  const targetEmployeeRange = resolveTargetEmployeeRange(options.message, options.filters);

  await emitStep(options.runStore, options.runId, options.sessionId, "query_expansion", {
    status: "started",
    fallbackRequestedLeadCount,
    llmCallsUsed: budget.used,
    llmCallsRemaining: budget.remaining
  });

  const queryPlan = await buildQueryPlan(options.message, options, budget);
  const requestedLeadCount = queryPlan.targetLeadCount ?? fallbackRequestedLeadCount;

  if (await isCancelled(options)) {
    const cancelledEarly = qualityGate([], requestedLeadCount, options.minConfidence, targetEmployeeRange);
    cancelledEarly.queryCount = queryPlan.queries.length;
    cancelledEarly.llmCallsUsed = budget.used;
    cancelledEarly.llmCallsRemaining = budget.remaining;
    cancelledEarly.cancelled = true;
    return cancelledEarly;
  }

  await emitStep(options.runStore, options.runId, options.sessionId, "query_expansion", {
    status: "completed",
    queryCount: queryPlan.queries.length,
    requestedLeadCount,
    requestedLeadCountSource: queryPlan.targetLeadCount ? "model_plan" : "fallback_parser",
    filtersApplied: options.filters,
    usedModelPlan: queryPlan.usedModelPlan,
    plannerFailureReason: queryPlan.plannerFailureReason,
    plannerFailureDetails: queryPlan.plannerFailureDetails,
    llmCallsUsed: budget.used,
    llmCallsRemaining: budget.remaining
  });

  const searchOutcomes: SearchOutcome[] = await Promise.all(
    queryPlan.queries.map(async (query) => {
      try {
        const searchResponse = await options.searchManager.search(query, options.searchMaxResults);
        return {
          query,
          provider: searchResponse.provider,
          fallbackUsed: searchResponse.fallbackUsed,
          resultCount: searchResponse.results.length,
          results: searchResponse.results
        };
      } catch (error) {
        return {
          query,
          error: error instanceof Error ? error.message.slice(0, 220) : String(error).slice(0, 220)
        };
      }
    })
  );

  const successfulSearches = searchOutcomes.filter(
    (outcome): outcome is SearchOutcomeSuccess =>
      "results" in outcome
  );
  const failedSearches = searchOutcomes
    .filter((outcome): outcome is SearchOutcomeFailure => "error" in outcome)
    .map((outcome) => ({ query: outcome.query, error: outcome.error }));

  const mergedResults = mergeSearchResults(
    successfulSearches.map((item) => item.results),
    options.maxPages
  );

  if (await isCancelled(options)) {
    const cancelledDuringSearch = qualityGate([], requestedLeadCount, options.minConfidence, targetEmployeeRange);
    cancelledDuringSearch.queryCount = queryPlan.queries.length;
    cancelledDuringSearch.llmCallsUsed = budget.used;
    cancelledDuringSearch.llmCallsRemaining = budget.remaining;
    cancelledDuringSearch.searchFailureCount = failedSearches.length;
    cancelledDuringSearch.searchFailureSamples = failedSearches.slice(0, 5);
    cancelledDuringSearch.cancelled = true;
    return cancelledDuringSearch;
  }

  await emitStep(options.runStore, options.runId, options.sessionId, "browse_batch", {
    status: "started",
    queryCount: queryPlan.queries.length,
    successfulQueries: successfulSearches.length,
    failedQueries: failedSearches.length,
    searchResultsSummary: successfulSearches.map((item) => ({
      query: item.query,
      provider: item.provider,
      fallbackUsed: item.fallbackUsed,
      resultCount: item.resultCount
    })),
    searchFailures: failedSearches,
    urlCount: mergedResults.length
  });

  const browserPool = await BrowserPool.create();
  let pagePayloads: PagePayload[] = [];
  let browseFailures: Array<{ url: string; error: string }> = [];
  try {
    const collection = await browserPool.collectPages(
      mergedResults.map((item) => item.url),
      options.browseConcurrency
    );
    pagePayloads = collection.pages;
    browseFailures = collection.failures;
  } finally {
    await browserPool.close();
  }

  await emitStep(options.runStore, options.runId, options.sessionId, "browse_batch", {
    status: "completed",
    urlCount: mergedResults.length,
    pagesVisited: pagePayloads.length,
    failedUrlCount: browseFailures.length,
    failedUrlSamples: browseFailures.slice(0, 8)
  });

  const batches = chunk(pagePayloads, options.extractionBatchSize);
  const extractedLeads: LeadCandidate[] = [];
  let cancelledDuringExtraction = false;

  for (let index = 0; index < batches.length; index += 1) {
    if (await isCancelled(options)) {
      cancelledDuringExtraction = true;
      break;
    }
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
    rawCandidateCount: extractedLeads.length,
    targetEmployeeRange
  });

  const gated = qualityGate(extractedLeads, requestedLeadCount, options.minConfidence, targetEmployeeRange);
  gated.queryCount = queryPlan.queries.length;
  gated.pagesVisited = pagePayloads.length;
  gated.llmCallsUsed = budget.used;
  gated.llmCallsRemaining = budget.remaining;
  gated.searchFailureCount = failedSearches.length;
  gated.searchFailureSamples = failedSearches.slice(0, 5);
  gated.browseFailureCount = browseFailures.length;
  gated.browseFailureSamples = browseFailures.slice(0, 8);
  gated.cancelled = cancelledDuringExtraction || (await isCancelled(options));

  await emitStep(options.runStore, options.runId, options.sessionId, "quality_gate", {
    status: "completed",
    requestedLeadCount,
    rawCandidateCount: gated.rawCandidateCount,
    validatedCandidateCount: gated.validatedCandidateCount,
    finalCandidateCount: gated.finalCandidateCount,
    deficitCount: gated.deficitCount,
    targetEmployeeRange: gated.sizeRangeRequested,
    sizeMatchBreakdown: gated.sizeMatchBreakdown,
    strictMinConfidence: gated.strictMinConfidence,
    effectiveMinConfidence: gated.effectiveMinConfidence,
    relaxedMinConfidence: gated.relaxedMinConfidence,
    relaxModeApplied: gated.relaxModeApplied,
    llmCallsUsed: gated.llmCallsUsed,
    llmCallsRemaining: gated.llmCallsRemaining
  });

  return gated;
}
