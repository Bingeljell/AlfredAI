import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { RunStatusProbe } from "../../scheduler/probes/runStatusProbe.js";

export const RunStatusInputSchema = z.object({ runId: z.string().min(1).max(256) }).strict();

export const toolDefinition: ToolDefinition<typeof RunStatusInputSchema> = {
  name: "run_status",
  description: "Read the terminal state of one Alfred run for a bounded scheduled task.",
  inputSchema: RunStatusInputSchema,
  inputHint: '{"runId":"run-id"}',
  async execute(input, context) {
    const result = await new RunStatusProbe(context.runStore).probe({ type: "run_status", runId: input.runId });
    return { status: result.status, summary: result.summary, digest: result.digest, terminal: result.terminal, changed: result.changed, errorCode: result.errorCode };
  },
};

