import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { browserSessions } from "../browser/browserController.js";

const InputSchema = z
  .object({
    index: z.number().int().min(0).max(500).optional(),
    text: z.string().min(1).max(200).optional(),
    value: z.string().max(50_000),
    pressEnter: z.boolean().optional()
  })
  .refine((value) => value.index !== undefined || value.text !== undefined, {
    message: "Provide index (from browser_snapshot) or a text label"
  });

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "browser_type",
  description:
    "Type text into an input on the current page of Alfred's persistent browser, by snapshot index or text label. Optionally press Enter (for search forms).",
  inputSchema: InputSchema,
  inputHint: '{"index": 1, "value": "hello world", "pressEnter": true}',
  async execute(input, context) {
    try {
      const controller = await browserSessions.forSession(context.sessionId);
      const typed = await controller.type({
        index: input.index,
        text: input.text,
        value: input.value
      });
      if (!typed.ok) {
        return { ok: false, target: null, error: typed.error };
      }
      if (input.pressEnter) {
        const pressed = await controller.pressKey("Enter", context.deadlineAtMs);
        return { ok: true, target: typed.target, pressEnter: true, url: pressed.url };
      }
      return { ok: true, target: typed.target };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "browser_type_failed" };
    }
  }
};
