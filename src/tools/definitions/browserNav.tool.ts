import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { browserSessions } from "../browser/browserController.js";

const InputSchema = z
  .object({
    action: z.enum(["back", "forward", "reload", "press"]),
    key: z.string().min(1).max(30).optional()
  })
  .refine((value) => value.action !== "press" || Boolean(value.key), {
    message: "key is required when action is press"
  });

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "browser_nav",
  description:
    "Navigate history (back/forward/reload) or send a keyboard key (Enter, Escape, Tab, ArrowDown, ...) to the current page of Alfred's persistent browser.",
  inputSchema: InputSchema,
  inputHint: '{"action": "press", "key": "Enter"}',
  async execute(input, context) {
    try {
      const controller = await browserSessions.forSession(context.sessionId);
      if (input.action === "press") {
        const pressed = await controller.pressKey(input.key as string, context.deadlineAtMs);
        return { action: "press", key: pressed.key, url: pressed.url };
      }
      const snapshot =
        input.action === "back"
          ? await controller.goBack(context.deadlineAtMs)
          : input.action === "forward"
            ? await controller.goForward(context.deadlineAtMs)
            : await controller.reload(context.deadlineAtMs);
      return {
        action: input.action,
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
        interactiveElements: snapshot.interactiveElements
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "browser_nav_failed" };
    }
  }
};
