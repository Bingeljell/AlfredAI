import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const execAsync = promisify(exec);

export const LogSessionInputSchema = z.object({
  summary: z.string().min(10).max(8000),
  title: z.string().max(120).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export const toolDefinition: ToolDefinition<typeof LogSessionInputSchema> = {
  name: "log_session",
  description:
    "Save a summary of the current session to Alfred's long-term knowledge base. Call at the end of any substantive session — completed tasks, key decisions, findings, or context that would be useful in future sessions. The summary is indexed by QMD and becomes searchable via rag_memory_query.",
  inputSchema: LogSessionInputSchema,
  inputHint:
    "Write a rich markdown summary: what was discussed/built, key decisions, outcomes, and anything Nikhil should remember. Include a title. Optionally set date (YYYY-MM-DD) to override today's date.",
  async execute(input, context) {
    const date = input.date ?? new Date().toISOString().slice(0, 10);
    const title = input.title ?? `Session — ${date}`;
    const sessionsDir = path.join(context.workspaceDir, "knowledge", "sessions");
    const filePath = path.join(sessionsDir, `${date}.md`);
    const knowledgeDir = path.join(context.workspaceDir, "knowledge");

    mkdirSync(sessionsDir, { recursive: true });

    const entry = `# ${title}\n_Date: ${date}_\n\n${input.summary.trim()}\n`;

    if (existsSync(filePath)) {
      // Append to existing day file with a separator
      const existing = readFileSync(filePath, "utf8");
      writeFileSync(filePath, existing.trimEnd() + "\n\n---\n\n" + entry);
    } else {
      writeFileSync(filePath, entry);
    }

    // Re-index so rag_memory_query picks up the new content
    // qmd update rescans files; qmd embed generates vectors (uses cached model after first run)
    try {
      await execAsync(`qmd update && qmd embed`, { cwd: knowledgeDir, timeout: 60_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Non-fatal: file is written, index refresh failed
      return {
        logged: true,
        filePath,
        date,
        indexRefreshed: false,
        indexError: msg.slice(0, 200)
      };
    }

    return { logged: true, filePath, date, indexRefreshed: true };
  }
};
