import { z } from "zod";

export const LeadObjectiveBriefSchema = z.object({
  objectiveSummary: z.string().min(8).max(400),
  companyType: z.string().min(2).max(160).nullable().optional(),
  industry: z.string().min(2).max(160).nullable().optional(),
  geography: z.string().min(2).max(160).nullable().optional(),
  businessModel: z.string().min(2).max(80).nullable().optional(),
  contactRequirement: z.string().min(2).max(160).nullable().optional(),
  constraintsMissing: z.array(z.string().min(2).max(80)).max(8).optional()
});

export const LeadExecutionBriefSchema = z.object({
  requestedLeadCount: z.number().int().min(1).max(100),
  objectiveBrief: LeadObjectiveBriefSchema,
  emailRequired: z.boolean().optional(),
  outputFormat: z.string().min(2).max(80).nullable().optional()
});

export const QueryExpansionSchema = z.object({
  queries: z.array(z.string().min(3)).min(3).max(5),
  targetLeadCount: z.number().int().min(1).max(100).nullable().optional(),
  objectiveBrief: LeadObjectiveBriefSchema
});

export const ExtractedLeadSchema = z.object({
  companyName: z.string().min(2),
  email: z.string().min(3).max(200).nullable().optional(),
  emailEvidence: z.string().min(2).max(260).nullable().optional(),
  website: z.string().url().nullable().optional(),
  location: z.string().min(2).max(120).nullable().optional(),
  employeeSizeText: z.preprocess(
    (v) => (typeof v === "string" && v.trim().length === 0 ? "unknown" : v),
    z.string().min(1).max(120)
  ),
  employeeMin: z.number().int().min(1).max(100000).nullable().optional(),
  employeeMax: z.number().int().min(1).max(100000).nullable().optional(),
  sizeEvidence: z.string().min(2).max(260).nullable().optional(),
  shortDesc: z.string().min(10).max(300),
  sourceUrl: z.string().url(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(8).max(260)
});

export const ExtractedLeadBatchSchema = z.object({
  leads: z.array(ExtractedLeadSchema).max(300)
});

export type ExtractedLead = z.infer<typeof ExtractedLeadSchema>;
export type ExtractedLeadBatch = z.infer<typeof ExtractedLeadBatchSchema>;
export type LeadObjectiveBrief = z.infer<typeof LeadObjectiveBriefSchema>;
export type LeadExecutionBrief = z.infer<typeof LeadExecutionBriefSchema>;
