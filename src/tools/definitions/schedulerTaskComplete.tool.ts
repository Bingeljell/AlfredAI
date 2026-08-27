import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const SchedulerTaskCompleteInputSchema = z.object({
  summary: z.string().trim().max(500).optional(),
}).strip();

export const toolDefinition: ToolDefinition<typeof SchedulerTaskCompleteInputSchema> = {
  name: "scheduler_task_complete",
  description: "Mark the server-bound current scheduler task cycle complete.",
  inputSchema: SchedulerTaskCompleteInputSchema,
  inputHint: '{"summary":"Condition satisfied"}',
  async execute(input, context) {
    const control = context.schedulerControl;
    if (!control) throw new Error("scheduler_control_unavailable");
    control.complete(input.summary);
    return { accepted: true, action: "complete", taskId: control.taskId, cycleId: control.cycleId };
  },
};
