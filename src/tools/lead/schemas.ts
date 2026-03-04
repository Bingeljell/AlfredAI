import { z } from "zod";

export const QueryExpansionSchema = z.object({
  queries: z.array(z.string().min(3)).min(3).max(5),
  targetLeadCount: z.number().int().min(10).max(100).optional()
});

export const ExtractedLeadSchema = z.object({
  companyName: z.string().min(2),
  website: z.string().url().optional(),
  location: z.string().min(2).max(120).optional(),
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
