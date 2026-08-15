import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { browserSessions } from "../browser/browserController.js";

const InputSchema = z
  .object({
    action: z.enum(["list", "open", "activate", "close"]),
    index: z.number().int().min(0).max(50).optional(),
    url: z.string().url().optional()
  })
  .refine(
    (value) =>
      value.action === "list" ||
      (value.action === "open" ? Boolean(value.url) : value.index !== undefined),
    { message: "url required when action=open; index required when action=activate|close" }
  );

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "browser_tabs",
  description:
    "Manage tabs in Alfred's persistent browser: list open tabs, open a new tab, activate a tab by index, or close a tab by index.",
  inputSchema: InputSchema,
  inputHint: '{"action": "open", "url": "https://example.com"}',
  async execute(input, context) {
    try {
      const controller = await browserSessions.forSession(context.sessionId);
      let tabs;
      if (input.action === "open") {
        tabs = await controller.openTab(input.url as string, context.deadlineAtMs);
      } else if (input.action === "activate") {
        tabs = await controller.activateTab(input.index as number);
      } else if (input.action === "close") {
        tabs = await controller.closeTab(input.index as number);
      } else {
        tabs = await controller.listTabs();
      }
      const active = tabs.find((tab) => tab.active);
      return { action: input.action, tabCount: tabs.length, activeTab: active ?? null, tabs };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "browser_tabs_failed" };
    }
  }
};
