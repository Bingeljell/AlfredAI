import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const SchedulerTaskCompleteInputSchema = z.object({
  taskId: z.string().uuid(),
  cycleId: z.string().min(1).max(512),
  summary: z.string().trim().max(500).optional(),
}).strict();

export const toolDefinition: ToolDefinition<typeof SchedulerTaskCompleteInputSchema> = {
  name: "scheduler_task_complete",
  description: "Mark the current scheduler task cycle complete after verifying its immutable task and cycle IDs.",
  inputSchema: SchedulerTaskCompleteInputSchema,
  inputHint: '{"taskId":"uuid","cycleId":"task:1","summary":"Condition satisfied"}',
  async execute(input, context) {
    const control = context.schedulerControl;
    if (!control || control.taskId !== input.taskId || control.cycleId !== input.cycleId) throw new Error("scheduler_task_cycle_mismatch");
    control.complete(input.summary);
    return { accepted: true, action: "complete", taskId: input.taskId, cycleId: input.cycleId };
  },
};

