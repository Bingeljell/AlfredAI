import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { DelayOrRunAtSchema, requireScheduler, resolveDueAt, validateDelayOrRunAt } from "../schedulerHelpers.js";

export const ScheduleReminderInputSchema = z.object({
  label: z.string().trim().min(1).max(256).default("Reminder"),
  reminderText: z.string().trim().min(1).max(4_000),
  intervalSeconds: z.number().int().min(60).max(365 * 24 * 60 * 60).optional(),
  maxCycles: z.number().int().min(1).max(50).optional(),
  ...DelayOrRunAtSchema.shape,
}).strict().superRefine(validateDelayOrRunAt);

export const toolDefinition: ToolDefinition<typeof ScheduleReminderInputSchema> = {
  name: "schedule_reminder",
  description: "Schedule a durable reminder for the current user and delivery channel.",
  inputSchema: ScheduleReminderInputSchema,
  inputHint: '{"reminderText":"Call Alice","delaySeconds":3600}',
  async execute(input, context) {
    requireScheduler(context);
    const task = await context.scheduler.schedule({
      kind: "reminder",
      label: input.label,
      reminderText: input.reminderText,
      dueAt: resolveDueAt(input),
      intervalSeconds: input.intervalSeconds,
      maxCycles: input.maxCycles,
    }, context.provenance, context.sessionId, context.runId);
    return { taskId: task.id, status: task.status, dueAt: task.dueAt, label: task.label };
  },
};
