import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { requireScheduler } from "../schedulerHelpers.js";

export const CancelScheduledTaskInputSchema = z.object({ taskId: z.string().uuid() }).strict();

export const toolDefinition: ToolDefinition<typeof CancelScheduledTaskInputSchema> = {
  name: "cancel_scheduled_task",
  description: "Cancel one of the current user's scheduled tasks.",
  inputSchema: CancelScheduledTaskInputSchema,
  inputHint: '{"taskId":"uuid"}',
  async execute(input, context) {
    requireScheduler(context);
    const owner = { sessionId: context.sessionId, principalId: context.provenance.principalId, channelKey: context.provenance.channelKey };
    const task = await context.scheduler.cancel(input.taskId, owner);
    return { taskId: task.id, status: task.status, label: task.label };
  },
};

