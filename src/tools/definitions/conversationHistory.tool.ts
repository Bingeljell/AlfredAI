import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({ before: z.string().optional(), limit: z.number().int().min(1).max(20).default(10) });

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "conversation_history",
  description: "Read older turns in the current conversation across all surfaces when the user refers to earlier work. Page backward with nextCursor.",
  inputSchema: InputSchema,
  inputHint: '{"limit":10}',
  async execute(input, context) {
    const history = await context.runStore.listHistory(context.sessionId, input);
    return {
      nextCursor: history.nextCursor,
      turns: history.runs.filter((run) => run.runId !== context.runId).map((run) => ({
        runId: run.runId, timestamp: run.createdAt, status: run.status, origin: run.ingress?.origin,
        message: run.message.slice(0, 8_000), answer: (run.assistantText ?? run.assistantPreview ?? "").slice(0, 8_000),
        artifacts: run.artifactPaths, truncated: run.message.length > 8_000 || (run.assistantText ?? run.assistantPreview ?? "").length > 8_000
      }))
    };
  }
};
