import { z } from "zod";

export const LeadPipelineFiltersSchema = z.object({
  employeeCountMin: z.number().int().min(1).max(100000).optional(),
  employeeCountMax: z.number().int().min(1).max(100000).optional(),
  country: z.string().min(2).max(80).optional(),
  industryKeywords: z
    .union([z.array(z.string().min(2).max(80)).max(12), z.string().min(2).max(240)])
    .optional(),
  requireEmail: z.boolean().optional()
});

export type LeadPipelineFilters = z.infer<typeof LeadPipelineFiltersSchema>;

export interface NormalizedLeadPipelineFilters {
  employeeCountMin?: number;
  employeeCountMax?: number;
  country?: string;
  industryKeywords?: string[];
  requireEmail?: boolean;
}

function normalizeIndustryKeywords(value: LeadPipelineFilters["industryKeywords"]): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const rawItems = Array.isArray(value) ? value : value.split(/[,|]/g);
  const normalized = rawItems
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeLeadPipelineFilters(
  filters: LeadPipelineFilters | undefined
): NormalizedLeadPipelineFilters | undefined {
  if (!filters) {
    return undefined;
  }

  const employeeCountMin = filters.employeeCountMin;
  const employeeCountMax = filters.employeeCountMax;

  const normalizedMin = employeeCountMin && employeeCountMax ? Math.min(employeeCountMin, employeeCountMax) : employeeCountMin;
  const normalizedMax = employeeCountMin && employeeCountMax ? Math.max(employeeCountMin, employeeCountMax) : employeeCountMax;
  const normalizedCountry = filters.country?.replace(/\s+/g, " ").trim();

  const normalized: NormalizedLeadPipelineFilters = {
    employeeCountMin: normalizedMin,
    employeeCountMax: normalizedMax,
    country: normalizedCountry || undefined,
    industryKeywords: normalizeIndustryKeywords(filters.industryKeywords),
    requireEmail: filters.requireEmail
  };

  if (
    !normalized.employeeCountMin &&
    !normalized.employeeCountMax &&
    !normalized.country &&
    !normalized.industryKeywords &&
    typeof normalized.requireEmail !== "boolean"
  ) {
    return undefined;
  }

  return normalized;
}
