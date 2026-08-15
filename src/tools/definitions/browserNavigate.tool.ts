import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { browserSessions } from "../browser/browserController.js";

const InputSchema = z.object({
  url: z.string().url()
});

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "browser_navigate",
  description:
    "Open a URL in Alfred's persistent browser (active tab) and return the page text plus numbered interactive elements. Call this before browser_click / browser_type / browser_screenshot.",
  inputSchema: InputSchema,
  inputHint: '{"url": "https://example.com"}',
  async execute(input, context) {
    try {
      const controller = await browserSessions.forSession(context.sessionId);
      const snapshot = await controller.navigate(input.url, context.deadlineAtMs);
      return {
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
        interactiveElements: snapshot.interactiveElements,
        outboundLinks: snapshot.outboundLinks.slice(0, 20)
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "browser_navigate_failed" };
    }
  }
};
