import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";

export const ProcessStopToolInputSchema = z.object({
  pid: z.number().int().min(1),
  force: z.boolean().optional()
});

export const toolDefinition: LeadAgentToolDefinition<typeof ProcessStopToolInputSchema> = {
  name: "process_stop",
  description: "Stop a local process by PID (trusted mode only).",
  inputSchema: ProcessStopToolInputSchema,
  inputHint: "Use carefully after confirming target with process_list.",
  async execute(input, context) {
    if (context.policyMode !== "trusted") {
      return {
        blocked: true,
        reason: "process_stop_blocked_in_balanced_mode",
        pid: input.pid
      };
    }

    const signal = input.force ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(input.pid, signal);
      return {
        blocked: false,
        stopped: true,
        pid: input.pid,
        signal
      };
    } catch (error) {
      return {
        blocked: false,
        stopped: false,
        pid: input.pid,
        signal,
        error: error instanceof Error ? error.message.slice(0, 200) : "process_stop_failed"
      };
    }
  }
};
