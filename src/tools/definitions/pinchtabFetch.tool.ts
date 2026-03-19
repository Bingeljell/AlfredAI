import { z } from "zod";
import type { LeadAgentToolDefinition } from "../types.js";
import { PinchtabPool } from "../lead/pinchtabPool.js";
import { appConfig } from "../../config/env.js";

const InputSchema = z.object({
  url: z.string().url(),
  maxChars: z.number().int().min(500).max(50_000).optional()
});

export const toolDefinition: LeadAgentToolDefinition<typeof InputSchema> = {
  name: "pinchtab_fetch",
  description:
    "Fetch a URL using Pinchtab (JS-rendered browser). Returns page text, title, and outbound links. Use instead of web_fetch for JS-heavy pages (Clutch, LinkedIn, etc.).",
  inputHint: "Provide a full URL. Use for JS-rendered pages where web_fetch returns empty or incomplete content.",
  inputSchema: InputSchema,
  async execute(input) {
    if (!appConfig.enablePinchtab) {
      return { error: "Pinchtab is not enabled. Set ALFRED_ENABLE_PINCHTAB=true and start the Pinchtab server." };
    }

    const pool = PinchtabPool.create(appConfig.pinchtabBaseUrl);
    const healthy = await pool.health();
    if (!healthy) {
      return { error: `Pinchtab server not reachable at ${appConfig.pinchtabBaseUrl}. Run: pinchtab` };
    }

    const result = await pool.collectPages([input.url], 1);

    if (result.failures.length > 0) {
      return { error: result.failures[0]?.error ?? "Unknown fetch error" };
    }

    const page = result.pages[0];
    if (!page) {
      return { error: "No page returned" };
    }

    return {
      url: page.url,
      title: page.title,
      text: input.maxChars ? page.text.slice(0, input.maxChars) : page.text,
      outboundLinks: page.outboundLinks.slice(0, 40),
      listItems: page.listItems.slice(0, 30)
    };
  }
};
