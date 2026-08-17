import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { DelayOrRunAtSchema, requireScheduler, resolveDueAt, validateDelayOrRunAt } from "../schedulerHelpers.js";

export const ScheduleWakeInputSchema = z.object({
  label: z.string().trim().min(1).max(256).default("Scheduled wake"),
  instruction: z.string().trim().min(1).max(1_000),
  intervalSeconds: z.number().int().min(60).max(365 * 24 * 60 * 60).optional(),
  maxCycles: z.number().int().min(1).max(50).optional(),
  ...DelayOrRunAtSchema.shape,
}).strict().superRefine(validateDelayOrRunAt);

export const toolDefinition: ToolDefinition<typeof ScheduleWakeInputSchema> = {
  name: "schedule_wake",
  description: "Schedule a bounded autonomous wake turn for the current user.",
  inputSchema: ScheduleWakeInputSchema,
  inputHint: '{"instruction":"Check whether the deployment finished","delaySeconds":300}',
  async execute(input, context) {
    requireScheduler(context);
    const task = await context.scheduler.schedule({
      kind: "wake_turn",
      label: input.label,
      instruction: input.instruction,
      dueAt: resolveDueAt(input),
      intervalSeconds: input.intervalSeconds,
      maxCycles: input.maxCycles,
    }, context.provenance, context.sessionId, context.runId);
    return { taskId: task.id, status: task.status, dueAt: task.dueAt, label: task.label };
  },
};
