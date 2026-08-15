import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { browserSessions } from "../browser/browserController.js";

const InputSchema = z.object({});

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "browser_close",
  description:
    "Shut down Alfred's persistent browser for this session and release its resources. Call when browser interaction is finished.",
  inputSchema: InputSchema,
  inputHint: "Use after the final browser interaction for this session.",
  async execute(_input, context) {
    try {
      const closed = await browserSessions.closeSession(context.sessionId);
      return { closed };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "browser_close_failed" };
    }
  }
};
