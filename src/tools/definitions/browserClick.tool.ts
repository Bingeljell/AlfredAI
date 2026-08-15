import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { browserSessions } from "../browser/browserController.js";

const InputSchema = z
  .object({
    index: z.number().int().min(0).max(500).optional(),
    text: z.string().min(1).max(200).optional()
  })
  .refine((value) => value.index !== undefined || value.text !== undefined, {
    message: "Provide index (from browser_snapshot) or a text label"
  });

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "browser_click",
  description:
    "Click an element on the current page of Alfred's persistent browser, by snapshot index or visible text label. Re-snapshot after the click to see the result.",
  inputSchema: InputSchema,
  inputHint: '{"index": 3}  or  {"text": "Submit"}',
  async execute(input, context) {
    try {
      const controller = await browserSessions.forSession(context.sessionId);
      const result = await controller.click(
        { index: input.index, text: input.text },
        context.deadlineAtMs
      );
      if (!result.ok) {
        return { ok: false, target: null, url: result.url, error: result.error };
      }
      return { ok: true, target: result.target, url: result.url };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "browser_click_failed" };
    }
  }
};
