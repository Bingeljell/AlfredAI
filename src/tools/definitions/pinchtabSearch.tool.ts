import { z } from "zod";
import type { LeadAgentToolDefinition } from "../types.js";
import { PinchtabPool } from "../lead/pinchtabPool.js";
import { appConfig } from "../../config/env.js";

const InputSchema = z.object({
  query: z.string().min(1).max(300),
  maxResults: z.number().int().min(1).max(20).default(10)
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const toolDefinition: LeadAgentToolDefinition<typeof InputSchema> = {
  name: "pinchtab_search",
  description:
    "Search Google via Pinchtab (real browser). Returns ranked URLs with titles and snippets. Use for targeted searches where SearxNG quality is insufficient.",
  inputHint: "Use for specific targeted queries. For broad discovery, prefer the search tool (SearxNG).",
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

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(input.query)}&num=${input.maxResults}`;
    const result = await pool.collectPages([searchUrl], 1);

    if (result.failures.length > 0) {
      return { error: result.failures[0]?.error ?? "Search failed" };
    }

    const page = result.pages[0];
    if (!page) {
      return { error: "No results returned" };
    }

    // Extract search result links — filter out Google UI links
    const resultLinks: SearchResult[] = page.outboundLinks
      .filter((link) => {
        const urlPart = link.split(" -> ")[1] ?? "";
        return (
          urlPart.startsWith("http") &&
          !urlPart.includes("google.com") &&
          !urlPart.includes("accounts.google") &&
          !urlPart.includes("support.google")
        );
      })
      .slice(0, input.maxResults)
      .map((link) => {
        const [label, url] = link.split(" -> ");
        return { title: label?.trim() ?? "", url: url?.trim() ?? "", snippet: "" };
      });

    return {
      query: input.query,
      resultCount: resultLinks.length,
      results: resultLinks
    };
  }
};
