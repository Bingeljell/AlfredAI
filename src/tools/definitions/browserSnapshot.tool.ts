import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { browserSessions } from "../browser/browserController.js";

const InputSchema = z.object({});

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "browser_snapshot",
  description:
    "Re-read the current page in Alfred's persistent browser: URL, title, text, numbered interactive elements, and outbound links. Call after browser_click / browser_type / browser_nav changed the page.",
  inputSchema: InputSchema,
  inputHint: "Use to inspect the current browser page before deciding the next interaction.",
  async execute(_input, context) {
    try {
      const controller = await browserSessions.forSession(context.sessionId);
      const snapshot = await controller.snapshot();
      return {
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
        interactiveElements: snapshot.interactiveElements,
        outboundLinks: snapshot.outboundLinks.slice(0, 20)
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "browser_snapshot_failed" };
    }
  }
};
