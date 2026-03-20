import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const execAsync = promisify(exec);

export const RagMemoryQueryInputSchema = z.object({
  query: z.string().min(3).max(400),
  maxResults: z.number().int().min(1).max(10).optional()
});

export const toolDefinition: ToolDefinition<typeof RagMemoryQueryInputSchema> = {
  name: "rag_memory_query",
  description:
    "Search Alfred's long-term knowledge base for facts, findings, and decisions from past sessions. Call this before searching the web when the topic may have been researched or discussed before.",
  inputSchema: RagMemoryQueryInputSchema,
  inputHint: "Pass a natural language query describing what you're looking for. Returns ranked relevant excerpts from past session notes.",
  async execute(input, _context) {
    const limit = input.maxResults ?? 5;
    // Sanitise the query for shell embedding — replace double quotes with single quotes
    const safeQuery = input.query.replace(/"/g, "'");

    try {
      const { stdout } = await execAsync(`qmd query "${safeQuery}" --json --limit ${limit}`, {
        timeout: 12_000
      });

      const trimmed = stdout.trim();
      if (!trimmed) {
        return { available: true, results: [], note: "No results found in knowledge base." };
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return { available: true, results: parsed };
      } catch {
        // QMD may output non-JSON in some modes — return raw text
        return { available: true, rawOutput: trimmed.slice(0, 3000) };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isNotInstalled =
        message.includes("not found") || message.includes("command not found") || message.includes("ENOENT");

      if (isNotInstalled) {
        return {
          available: false,
          reason:
            "QMD not installed or not on PATH. To enable long-term memory: npm install -g @tobilu/qmd && qmd collection add ./workspace/alfred/knowledge --name alfred-knowledge && qmd embed"
        };
      }

      return { available: false, reason: message.slice(0, 300) };
    }
  }
};
