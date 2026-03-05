import type { LeadCandidate, LeadSizeMatch, LlmUsage, LlmUsageTotals, SearchProviderName, SearchResult } from "../../types.js";
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
  runEmailEnrichment?: boolean;
  filters?: NormalizedLeadPipelineFilters;
  deadlineAtMs?: number;
  isCancellationRequested?: () => Promise<boolean>;
}

export interface LeadSubReactResult {
  leads: LeadCandidate[];
  cancelled: boolean;
  timedOut?: boolean;
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
  extractionFailureCount?: number;
  extractionFailureSamples?: Array<{ batchIndex: number; reason: string }>;
  emailLeadCount?: number;
  emailCoverageRatio?: number;
  emailEnrichmentAttempted?: boolean;
  emailEnrichmentUpdatedCount?: number;
  emailEnrichmentFailureCount?: number;
  emailEnrichmentFailureSamples?: Array<{ url: string; error: string }>;
  emailEnrichmentUrlCap?: number;
  emailEnrichmentStoppedEarlyReason?: string;
  emailRequested?: boolean;
  llmUsage: LlmUsageTotals;
}

interface QueryPlanResult {
  queries: string[];
  targetLeadCount?: number;
  plannerFailureReason?: string;
  plannerFailureDetails?: StructuredChatHttpErrorDetails;
  usedModelPlan: boolean;
  llmUsage?: LlmUsage;
}

interface ExtractBatchResult {
  leads: LeadCandidate[];
  attemptsUsed: number;
  failureReasons: string[];
  failureDetails: Array<Record<string, unknown>>;
  llmUsage: LlmUsageTotals;
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

interface EmailEnrichmentResult {
  attempted: boolean;
  candidateLeadCount: number;
  candidateUrlCount: number;
  urlCap: number;
  pagesVisited: number;
  updatedLeadCount: number;
  failureCount: number;
  failureSamples: Array<{ url: string; error: string }>;
  stoppedEarlyReason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyLlmUsageTotals(): LlmUsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    callCount: 0
  };
}

function addLlmUsage(totals: LlmUsageTotals, usage: LlmUsage | undefined): void {
  if (!usage) {
    return;
  }
  totals.promptTokens += Math.max(0, Math.round(usage.promptTokens));
  totals.completionTokens += Math.max(0, Math.round(usage.completionTokens));
  totals.totalTokens += Math.max(0, Math.round(usage.totalTokens));
}

function parseLocationHint(message: string): string | undefined {
  const match = message.match(/\bin\s+([A-Za-z][A-Za-z\s]{1,40})$/i);
  return match?.[1]?.trim();
}

function isEmailRequested(message: string, filters: NormalizedLeadPipelineFilters | undefined): boolean {
  if (filters?.requireEmail === true) {
    return true;
  }

  return /\bemails?\b|\bcontact\s+(?:email|details?)\b|\bemail\s+contacts?\b/i.test(message);
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
    .replace(/\b(incorporated|inc|llc|ltd|corp|corporation|co|company)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocationKey(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKeyForLead(lead: LeadCandidate): string {
  const company = normalizeCompanyName(lead.companyName);
  const location = normalizeLocationKey(lead.location);
  if (company && location) {
    return `name:${company}|loc:${location}`;
  }
  if (company) {
    return `name:${company}`;
  }

  const websiteDomain = normalizeDomain(lead.website);
  if (websiteDomain) {
    return `domain:${websiteDomain}`;
  }

  const sourceDomain = normalizeDomain(lead.sourceUrl);
  if (sourceDomain) {
    return `source_domain:${sourceDomain}`;
  }
  return `source:${lead.sourceUrl}`;
}

export const leadDedupeForTests = {
  dedupeKeyForLead
};

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

function buildEmailEnrichmentTargets(leads: LeadCandidate[], requestedLeadCount: number): LeadCandidate[] {
  const maxTargets = Math.min(20, Math.max(8, requestedLeadCount));
  return dedupeLeads(leads)
    .filter((lead) => !lead.email && Boolean(lead.website))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxTargets);
}

function computeEmailEnrichmentUrlCap(options: LeadSubReactOptions): number {
  if (!options.deadlineAtMs) {
    return 80;
  }
  const remainingMs = options.deadlineAtMs - Date.now();
  if (remainingMs <= 20_000) {
    return 0;
  }
  if (remainingMs <= 60_000) {
    return 8;
  }
  if (remainingMs <= 120_000) {
    return 16;
  }
  if (remainingMs <= 240_000) {
    return 24;
  }
  return 40;
}

function buildEmailCandidateUrls(lead: LeadCandidate): string[] {
  if (!lead.website) {
    return [];
  }
  try {
    const website = new URL(lead.website);
    const origin = website.origin;
    return [
      origin,
      `${origin}/contact`,
      `${origin}/contact-us`,
      `${origin}/about`
    ];
  } catch {
    return [];
  }
}

function normalizeEmailCandidates(value: string): string[] {
  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const normalized = matches
    .map((item) => normalizeEmail(item.replace(/[),.;:!?]+$/g, "")))
    .filter((item): item is string => Boolean(item))
    .filter((item) => !item.endsWith(".png") && !item.endsWith(".jpg") && !item.endsWith(".svg"));
  return Array.from(new Set(normalized));
}

function pickBestEmail(candidates: string[]): string | undefined {
  const scored = candidates
    .map((email) => {
      let score = 0;
      if (/^info@|^contact@|^hello@|^sales@/i.test(email)) {
        score += 3;
      }
      if (/^noreply@|^no-reply@|^donotreply@/i.test(email)) {
        score -= 5;
      }
      if (/example\.com$/i.test(email)) {
        score -= 8;
      }
      return { email, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.email;
}

function extractEmailsFromPayload(payload: PagePayload): string[] {
  const blob = [
    payload.text,
    payload.listItems.join("\n"),
    payload.tableRows.join("\n"),
    payload.outboundLinks.join("\n")
  ].join("\n");
  return normalizeEmailCandidates(blob);
}

export const emailEnrichmentForTests = {
  normalizeEmailCandidates,
  pickBestEmail,
  extractEmailsFromPayload,
  computeEmailEnrichmentUrlCap
};

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

function scoreLead(
  lead: LeadCandidate,
  targetRange: EmployeeSizeRange | undefined,
  emailRequested: boolean
): number {
  const completeness = [lead.website, lead.location, lead.shortDesc, lead.evidence, lead.email].filter(Boolean).length / 5;
  const citationBonus = lead.evidence.length > 30 ? 0.05 : 0;
  const sizeMatch = lead.sizeMatch ?? deriveSizeMatch(lead, targetRange);
  const sizeAdjustment: Record<LeadSizeMatch, number> = {
    in_range: 0.12,
    near_range: 0.03,
    unknown: 0,
    out_of_range: -0.18
  };
  const sizeScoreDelta = targetRange ? sizeAdjustment[sizeMatch] : 0;
  const emailAdjustment = lead.email ? 0.08 : emailRequested ? -0.12 : -0.05;
  return Math.min(1, Math.max(0, lead.confidence * 0.72 + completeness * 0.2 + citationBonus + sizeScoreDelta + emailAdjustment));
}

export const leadQualityScoringForTests = {
  deriveSizeMatch,
  scoreLead
};

function qualityGate(
  leads: LeadCandidate[],
  requestedLeadCount: number,
  minConfidence: number,
  targetEmployeeRange: EmployeeSizeRange | undefined,
  emailRequested: boolean
): LeadSubReactResult {
  const minFinal = 15;
  const maxFinal = Math.min(25, requestedLeadCount);

  const deduped: LeadCandidate[] = dedupeLeads(leads)
    .map((lead) => {
      const sizeMatch = deriveSizeMatch(lead, targetEmployeeRange);
      return {
        ...lead,
        sizeMatch,
        confidence: scoreLead({ ...lead, sizeMatch }, targetEmployeeRange, emailRequested),
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
    timedOut: false,
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
    browseFailureSamples: [],
    extractionFailureCount: 0,
    extractionFailureSamples: [],
    emailRequested,
    llmUsage: emptyLlmUsageTotals()
  };
}

async function isCancelled(options: LeadSubReactOptions): Promise<boolean> {
  if (!options.isCancellationRequested) {
    return false;
  }
  return options.isCancellationRequested();
}

function remainingDeadlineMs(options: LeadSubReactOptions): number | undefined {
  if (!options.deadlineAtMs) {
    return undefined;
  }
  return options.deadlineAtMs - Date.now();
}

function hasTimedOut(options: LeadSubReactOptions): boolean {
  const remaining = remainingDeadlineMs(options);
  return typeof remaining === "number" ? remaining <= 0 : false;
}

async function emitStep(
  runStore: RunStore,
  runId: string,
  sessionId: string,
  step: "query_expansion" | "browse_batch" | "extraction" | "email_enrichment" | "quality_gate",
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
      plannerFailureReason: !options.openAiApiKey ? "missing_api_key" : "llm_budget_exhausted",
      llmUsage: undefined
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
      plannerFailureDetails: diagnostic.httpErrorDetails,
      llmUsage: diagnostic.usage
    };
  }

  return {
    queries: diagnostic.result.queries.map((query) => query.trim()).filter(Boolean).slice(0, 5),
    targetLeadCount: diagnostic.result.targetLeadCount ?? undefined,
    usedModelPlan: true,
    llmUsage: diagnostic.usage
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
  const llmUsage = emptyLlmUsageTotals();

  if (!options.openAiApiKey) {
    return {
      leads: [],
      attemptsUsed: 0,
      failureReasons: ["missing_api_key"],
      failureDetails: [{ attempt: 0, failureCode: "missing_api_key", failureMessage: "OpenAI API key is not configured" }],
      llmUsage
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
      ],
      llmUsage
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
  addLlmUsage(llmUsage, firstAttempt.usage);

  if (firstAttempt.result) {
    return {
      leads: firstAttempt.result.leads.map(normalizeCandidate),
      attemptsUsed,
      failureReasons,
      failureDetails,
      llmUsage
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
      failureDetails,
      llmUsage
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
  addLlmUsage(llmUsage, retryAttempt.usage);

  if (retryAttempt.result) {
    return {
      leads: retryAttempt.result.leads.map(normalizeCandidate),
      attemptsUsed,
      failureReasons,
      failureDetails,
      llmUsage
    };
  }

  failureReasons.push(`attempt_2:${formatDiagnosticReason(retryAttempt)}`);
  failureDetails.push(diagnosticDetails(retryAttempt, 2));
  return {
    leads: [],
    attemptsUsed,
    failureReasons,
    failureDetails,
    llmUsage
  };
}

async function enrichLeadEmails(
  leads: LeadCandidate[],
  requestedLeadCount: number,
  options: LeadSubReactOptions
): Promise<EmailEnrichmentResult> {
  const targets = buildEmailEnrichmentTargets(leads, requestedLeadCount);
  const urlCap = computeEmailEnrichmentUrlCap(options);
  if (targets.length === 0) {
    return {
      attempted: false,
      candidateLeadCount: 0,
      candidateUrlCount: 0,
      urlCap,
      pagesVisited: 0,
      updatedLeadCount: 0,
      failureCount: 0,
      failureSamples: []
    };
  }

  const domainToLeadIndexes = new Map<string, number[]>();
  for (let index = 0; index < leads.length; index += 1) {
    const lead = leads[index];
    if (!lead || lead.email || !lead.website) {
      continue;
    }
    const domain = normalizeDomain(lead.website);
    if (!domain) {
      continue;
    }
    const entries = domainToLeadIndexes.get(domain) ?? [];
    entries.push(index);
    domainToLeadIndexes.set(domain, entries);
  }

  const urls = Array.from(
    new Set(targets.flatMap((lead) => buildEmailCandidateUrls(lead)))
  ).slice(0, urlCap);

  if (urls.length === 0) {
    return {
      attempted: false,
      candidateLeadCount: targets.length,
      candidateUrlCount: 0,
      urlCap,
      pagesVisited: 0,
      updatedLeadCount: 0,
      failureCount: 0,
      failureSamples: []
    };
  }

  const browserPool = await BrowserPool.create();
  try {
    const collection = await browserPool.collectPages(urls, options.browseConcurrency, options.deadlineAtMs);
    const visitedByDomain = new Set<string>();
    let updatedLeadCount = 0;
    let pagesVisited = 0;
    let noUpdateStreak = 0;
    let stoppedEarlyReason: string | undefined;

    for (const payload of collection.pages) {
      if (hasTimedOut(options)) {
        stoppedEarlyReason = "deadline_exhausted";
        break;
      }
      pagesVisited += 1;
      const sourceDomain = normalizeDomain(payload.url);
      if (!sourceDomain || visitedByDomain.has(sourceDomain)) {
        noUpdateStreak += 1;
        if (noUpdateStreak >= 12) {
          stoppedEarlyReason = "email_diminishing_returns";
          break;
        }
        continue;
      }
      const emails = extractEmailsFromPayload(payload);
      const bestEmail = pickBestEmail(emails);
      if (!bestEmail) {
        noUpdateStreak += 1;
        if (noUpdateStreak >= 12) {
          stoppedEarlyReason = "email_diminishing_returns";
          break;
        }
        continue;
      }

      const leadIndexes = domainToLeadIndexes.get(sourceDomain) ?? [];
      if (leadIndexes.length === 0) {
        noUpdateStreak += 1;
        if (noUpdateStreak >= 12) {
          stoppedEarlyReason = "email_diminishing_returns";
          break;
        }
        continue;
      }

      let evidencePath = "homepage";
      try {
        const parsedUrl = new URL(payload.url);
        evidencePath = parsedUrl.pathname === "/" ? "homepage" : parsedUrl.pathname;
      } catch {
        evidencePath = "website";
      }

      for (const leadIndex of leadIndexes) {
        const lead = leads[leadIndex];
        if (!lead || lead.email) {
          continue;
        }
        lead.email = bestEmail;
        lead.emailEvidence = `email enrichment: ${evidencePath}`;
        updatedLeadCount += 1;
      }
      visitedByDomain.add(sourceDomain);
      noUpdateStreak = 0;
    }

    return {
      attempted: true,
      candidateLeadCount: targets.length,
      candidateUrlCount: urls.length,
      urlCap,
      pagesVisited,
      updatedLeadCount,
      failureCount: collection.failures.length,
      failureSamples: collection.failures.slice(0, 8),
      stoppedEarlyReason
    };
  } finally {
    await browserPool.close();
  }
}

export async function executeLeadSubReactPipeline(options: LeadSubReactOptions): Promise<LeadSubReactResult> {
  const budget = new LlmBudgetManager(options.llmMaxCalls);
  const llmUsage = emptyLlmUsageTotals();
  const fallbackRequestedLeadCount = parseRequestedLeadCount(options.message);
  const targetEmployeeRange = resolveTargetEmployeeRange(options.message, options.filters);
  const emailRequested = isEmailRequested(options.message, options.filters);

  await emitStep(options.runStore, options.runId, options.sessionId, "query_expansion", {
    status: "started",
    fallbackRequestedLeadCount,
    llmCallsUsed: budget.used,
    llmCallsRemaining: budget.remaining
  });

  const queryPlan = await buildQueryPlan(options.message, options, budget);
  addLlmUsage(llmUsage, queryPlan.llmUsage);
  const requestedLeadCount = queryPlan.targetLeadCount ?? fallbackRequestedLeadCount;

  if (hasTimedOut(options)) {
    const timedOutEarly = qualityGate([], requestedLeadCount, options.minConfidence, targetEmployeeRange, emailRequested);
    timedOutEarly.queryCount = queryPlan.queries.length;
    timedOutEarly.llmCallsUsed = budget.used;
    timedOutEarly.llmCallsRemaining = budget.remaining;
    timedOutEarly.llmUsage = { ...llmUsage, callCount: budget.used };
    timedOutEarly.timedOut = true;
    return timedOutEarly;
  }

  if (await isCancelled(options)) {
    const cancelledEarly = qualityGate([], requestedLeadCount, options.minConfidence, targetEmployeeRange, emailRequested);
    cancelledEarly.queryCount = queryPlan.queries.length;
    cancelledEarly.llmCallsUsed = budget.used;
    cancelledEarly.llmCallsRemaining = budget.remaining;
    cancelledEarly.llmUsage = { ...llmUsage, callCount: budget.used };
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
    llmCallsRemaining: budget.remaining,
    llmUsage
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

  if (hasTimedOut(options)) {
    const timedOutDuringSearch = qualityGate([], requestedLeadCount, options.minConfidence, targetEmployeeRange, emailRequested);
    timedOutDuringSearch.queryCount = queryPlan.queries.length;
    timedOutDuringSearch.llmCallsUsed = budget.used;
    timedOutDuringSearch.llmCallsRemaining = budget.remaining;
    timedOutDuringSearch.llmUsage = { ...llmUsage, callCount: budget.used };
    timedOutDuringSearch.searchFailureCount = failedSearches.length;
    timedOutDuringSearch.searchFailureSamples = failedSearches.slice(0, 5);
    timedOutDuringSearch.timedOut = true;
    return timedOutDuringSearch;
  }

  if (await isCancelled(options)) {
    const cancelledDuringSearch = qualityGate([], requestedLeadCount, options.minConfidence, targetEmployeeRange, emailRequested);
    cancelledDuringSearch.queryCount = queryPlan.queries.length;
    cancelledDuringSearch.llmCallsUsed = budget.used;
    cancelledDuringSearch.llmCallsRemaining = budget.remaining;
    cancelledDuringSearch.llmUsage = { ...llmUsage, callCount: budget.used };
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
      options.browseConcurrency,
      options.deadlineAtMs
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
  const extractionFailureSamples: Array<{ batchIndex: number; reason: string }> = [];
  let cancelledDuringExtraction = false;
  let timedOutDuringExtraction = false;

  for (let index = 0; index < batches.length; index += 1) {
    if (hasTimedOut(options)) {
      timedOutDuringExtraction = true;
      break;
    }
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
    addLlmUsage(llmUsage, extraction.llmUsage);
    extractedLeads.push(...extraction.leads);
    if (extraction.failureReasons.length > 0) {
      for (const reason of extraction.failureReasons) {
        extractionFailureSamples.push({
          batchIndex: index + 1,
          reason: reason.slice(0, 220)
        });
      }
    }

    await emitStep(options.runStore, options.runId, options.sessionId, "extraction", {
      status: "completed",
      batchIndex: index + 1,
      totalBatches: batches.length,
      extractedCount: extraction.leads.length,
      attemptsUsed: extraction.attemptsUsed,
      failureReasons: extraction.failureReasons,
      failureDetails: extraction.failureDetails,
      llmCallsUsed: budget.used,
      llmCallsRemaining: budget.remaining,
      llmUsage
    });
  }

  const emailTargets = buildEmailEnrichmentTargets(extractedLeads, requestedLeadCount);
  const shouldRunEmailEnrichment = options.runEmailEnrichment ?? true;
  await emitStep(options.runStore, options.runId, options.sessionId, "email_enrichment", {
    status: "started",
    candidateLeadCount: emailTargets.length,
    skippedForTimeout: hasTimedOut(options),
    skippedByPlanner: !shouldRunEmailEnrichment
  });

  const emailEnrichment = !shouldRunEmailEnrichment
    ? {
        attempted: false,
        candidateLeadCount: emailTargets.length,
        candidateUrlCount: 0,
        urlCap: 0,
        pagesVisited: 0,
        updatedLeadCount: 0,
        failureCount: 0,
        failureSamples: [],
        stoppedEarlyReason: "planner_disabled_email_enrichment"
      }
    : hasTimedOut(options)
    ? {
        attempted: false,
        candidateLeadCount: emailTargets.length,
        candidateUrlCount: 0,
        urlCap: 0,
        pagesVisited: 0,
        updatedLeadCount: 0,
        failureCount: 0,
        failureSamples: [],
        stoppedEarlyReason: "deadline_exhausted"
      }
    : await enrichLeadEmails(extractedLeads, requestedLeadCount, options);

  await emitStep(options.runStore, options.runId, options.sessionId, "email_enrichment", {
    status: "completed",
    attempted: emailEnrichment.attempted,
    candidateLeadCount: emailEnrichment.candidateLeadCount,
    candidateUrlCount: emailEnrichment.candidateUrlCount,
    urlCap: emailEnrichment.urlCap,
    pagesVisited: emailEnrichment.pagesVisited,
    updatedLeadCount: emailEnrichment.updatedLeadCount,
    failureCount: emailEnrichment.failureCount,
    failureSamples: emailEnrichment.failureSamples,
    stoppedEarlyReason: emailEnrichment.stoppedEarlyReason,
    skippedByPlanner: !shouldRunEmailEnrichment
  });

  await emitStep(options.runStore, options.runId, options.sessionId, "quality_gate", {
    status: "started",
    rawCandidateCount: extractedLeads.length,
    targetEmployeeRange
  });

  const gated = qualityGate(extractedLeads, requestedLeadCount, options.minConfidence, targetEmployeeRange, emailRequested);
  gated.queryCount = queryPlan.queries.length;
  gated.pagesVisited = pagePayloads.length;
  gated.llmCallsUsed = budget.used;
  gated.llmCallsRemaining = budget.remaining;
  gated.llmUsage = { ...llmUsage, callCount: budget.used };
  gated.searchFailureCount = failedSearches.length;
  gated.searchFailureSamples = failedSearches.slice(0, 5);
  gated.browseFailureCount = browseFailures.length;
  gated.browseFailureSamples = browseFailures.slice(0, 8);
  gated.extractionFailureCount = extractionFailureSamples.length;
  gated.extractionFailureSamples = extractionFailureSamples.slice(0, 12);
  gated.emailLeadCount = gated.leads.filter((lead) => Boolean(lead.email)).length;
  gated.emailCoverageRatio = gated.leads.length > 0 ? gated.emailLeadCount / gated.leads.length : 0;
  gated.emailEnrichmentAttempted = emailEnrichment.attempted;
  gated.emailEnrichmentUpdatedCount = emailEnrichment.updatedLeadCount;
  gated.emailEnrichmentFailureCount = emailEnrichment.failureCount;
  gated.emailEnrichmentFailureSamples = emailEnrichment.failureSamples;
  gated.emailEnrichmentUrlCap = emailEnrichment.urlCap;
  gated.emailEnrichmentStoppedEarlyReason = emailEnrichment.stoppedEarlyReason;
  gated.emailRequested = emailRequested;
  gated.cancelled = cancelledDuringExtraction || (await isCancelled(options));
  gated.timedOut = timedOutDuringExtraction || hasTimedOut(options);

  await emitStep(options.runStore, options.runId, options.sessionId, "quality_gate", {
    status: "completed",
    requestedLeadCount,
    emailRequested,
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
    extractionFailureCount: gated.extractionFailureCount,
    extractionFailureSamples: gated.extractionFailureSamples,
    timedOut: gated.timedOut,
    emailLeadCount: gated.emailLeadCount,
    emailCoverageRatio: gated.emailCoverageRatio,
    emailEnrichmentUpdatedCount: gated.emailEnrichmentUpdatedCount,
    emailEnrichmentUrlCap: gated.emailEnrichmentUrlCap,
    emailEnrichmentStoppedEarlyReason: gated.emailEnrichmentStoppedEarlyReason,
    llmCallsUsed: gated.llmCallsUsed,
    llmCallsRemaining: gated.llmCallsRemaining,
    llmUsage: gated.llmUsage
  });

  return gated;
}
