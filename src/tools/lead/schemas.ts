import { z } from "zod";

export const QueryExpansionSchema = z.object({
  queries: z.array(z.string().min(3)).min(3).max(5),
  targetLeadCount: z.number().int().min(10).max(100).nullable().optional()
});

export const ExtractedLeadSchema = z.object({
  companyName: z.string().min(2),
  email: z.string().min(3).max(200).nullable().optional(),
  website: z.string().url().nullable().optional(),
  location: z.string().min(2).max(120).nullable().optional(),
  employeeSizeText: z.string().min(2).max(120).nullable().optional(),
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
