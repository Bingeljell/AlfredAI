import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { toolApprovalActionKey, toolApprovalStore } from "../../runtime/toolApprovalStore.js";

export const ProcessStopToolInputSchema = z.object({
  pid: z.number().int().min(1),
  force: z.boolean().optional()
});

export const toolDefinition: ToolDefinition<typeof ProcessStopToolInputSchema> = {
  name: "process_stop",
  description: "Stop a local process by PID, subject to the configured access mode.",
  inputSchema: ProcessStopToolInputSchema,
  inputHint: "Use carefully after confirming target with process_list.",
  async execute(input, context) {
    if (context.policyMode === "limited") {
      return {
        blocked: true,
        reason: "process_stop_disabled_in_limited_mode",
        pid: input.pid
      };
    }
    if (context.policyMode === "balanced") {
      const actionKey = toolApprovalActionKey("process_stop", input);
      if (!toolApprovalStore.consume(context.sessionId, actionKey)) {
        const approval = toolApprovalStore.request(context.sessionId, actionKey, `process_stop: PID ${input.pid}${input.force ? " (force)" : ""}`);
        return {
          blocked: true,
          reason: "approval_required",
          approvalToken: approval.token,
          pid: input.pid,
          expiresAt: approval.expiresAt,
          nextStep: `Send /approve ${approval.token}, then ask Alfred to retry the same action.`
        };
      }
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
