import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { WatchDefinitionSchema } from "../../scheduler/schemas.js";
import { requireScheduler, resolveDueAt } from "../schedulerHelpers.js";

export const ScheduleWatchInputSchema = z.object({
  label: z.string().trim().min(1).max(256).default("Scheduled watch"),
  watch: WatchDefinitionSchema,
  instruction: z.string().trim().min(1).max(1_000).optional(),
  intervalSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).default(60),
  expiresInSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).default(24 * 60 * 60),
  maxCycles: z.number().int().min(1).max(50).default(10),
}).strict();

export const toolDefinition: ToolDefinition<typeof ScheduleWatchInputSchema> = {
  name: "schedule_watch",
  description: "Persistently watch a supported run, file, or Herdr agent state and notify on a meaningful transition.",
  inputSchema: ScheduleWatchInputSchema,
  inputHint: '{"watch":{"type":"file_exists","relativePath":"workspace/result.md"},"intervalSeconds":60}',
  async execute(input, context) {
    requireScheduler(context);
    const now = Date.now();
    const task = await context.scheduler.schedule({
      kind: "watch",
      label: input.label,
      watch: input.watch,
      instruction: input.instruction,
      dueAt: resolveDueAt({ delaySeconds: 5 }, now),
      expiresAt: new Date(now + input.expiresInSeconds * 1_000).toISOString(),
      intervalSeconds: input.intervalSeconds,
      maxCycles: input.maxCycles,
    }, context.provenance, context.sessionId, context.runId);
    return { taskId: task.id, status: task.status, dueAt: task.dueAt, expiresAt: task.expiresAt, label: task.label };
  },
};

