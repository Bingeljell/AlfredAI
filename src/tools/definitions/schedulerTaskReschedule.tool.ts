import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const SchedulerTaskRescheduleInputSchema = z.object({
  taskId: z.string().uuid(),
  cycleId: z.string().min(1).max(512),
  delaySeconds: z.number().int().min(60).max(365 * 24 * 60 * 60),
  reason: z.string().trim().max(500).optional(),
}).strict();

export const toolDefinition: ToolDefinition<typeof SchedulerTaskRescheduleInputSchema> = {
  name: "scheduler_task_reschedule",
  description: "Reschedule the current scheduler task cycle after verifying its immutable task and cycle IDs.",
  inputSchema: SchedulerTaskRescheduleInputSchema,
  inputHint: '{"taskId":"uuid","cycleId":"task:1","delaySeconds":60}',
  async execute(input, context) {
    const control = context.schedulerControl;
    if (!control || control.taskId !== input.taskId || control.cycleId !== input.cycleId) throw new Error("scheduler_task_cycle_mismatch");
    control.reschedule(new Date(Date.now() + input.delaySeconds * 1_000).toISOString(), input.reason);
    return { accepted: true, action: "reschedule", taskId: input.taskId, cycleId: input.cycleId };
  },
};
