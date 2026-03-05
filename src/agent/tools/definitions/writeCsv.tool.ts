import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";
import { writeLeadsCsv } from "../../../tools/csv/writeCsv.js";

export const WriteCsvToolInputSchema = z.object({});

export const toolDefinition: LeadAgentToolDefinition<typeof WriteCsvToolInputSchema> = {
  name: "write_csv",
  description: "Write current accumulated leads to artifact CSV.",
  inputSchema: WriteCsvToolInputSchema,
  inputHint: "Use at the end of the run (or checkpoints) to persist current lead set.",
  async execute(_input, context) {
    const csvPath = await writeLeadsCsv(context.workspaceDir, context.runId, context.state.leads);
    context.addArtifact(csvPath);

    return {
      csvPath,
      candidateCount: context.state.leads.length
    };
  }
};
