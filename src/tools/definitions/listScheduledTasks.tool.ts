import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { requireScheduler } from "../schedulerHelpers.js";

export const ListScheduledTasksInputSchema = z.object({ includeTerminal: z.boolean().default(false) }).strict();

export const toolDefinition: ToolDefinition<typeof ListScheduledTasksInputSchema> = {
  name: "list_scheduled_tasks",
  description: "List scheduled tasks owned by the current user and session.",
  inputSchema: ListScheduledTasksInputSchema,
  inputHint: '{"includeTerminal":false}',
  async execute(input, context) {
    requireScheduler(context);
    const owner = { sessionId: context.sessionId, principalId: context.provenance.principalId, channelKey: context.provenance.channelKey };
    const tasks = await context.scheduler.list(owner, input.includeTerminal);
    return { tasks: tasks.map((task) => ({ id: task.id, label: task.label, kind: task.kind, status: task.status, dueAt: task.dueAt, expiresAt: task.expiresAt, cycleCount: task.cycleCount, maxCycles: task.maxCycles })) };
  },
};

