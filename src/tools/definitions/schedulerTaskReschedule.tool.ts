import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const SchedulerTaskRescheduleInputSchema = z.object({
  delaySeconds: z.number().int().min(60).max(365 * 24 * 60 * 60),
  reason: z.string().trim().max(500).optional(),
}).strip();

export const toolDefinition: ToolDefinition<typeof SchedulerTaskRescheduleInputSchema> = {
  name: "scheduler_task_reschedule",
  description: "Reschedule the server-bound current scheduler task cycle.",
  inputSchema: SchedulerTaskRescheduleInputSchema,
  inputHint: '{"delaySeconds":60,"reason":"Condition not satisfied yet"}',
  async execute(input, context) {
    const control = context.schedulerControl;
    if (!control) throw new Error("scheduler_control_unavailable");
    control.reschedule(new Date(Date.now() + input.delaySeconds * 1_000).toISOString(), input.reason);
    return { accepted: true, action: "reschedule", taskId: control.taskId, cycleId: control.cycleId };
  },
};
