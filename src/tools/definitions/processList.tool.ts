import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { LeadAgentToolDefinition } from "../types.js";

const exec = promisify(execCallback);

export const ProcessListToolInputSchema = z.object({
  query: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).optional()
});

interface ProcessRow {
  pid: number;
  command: string;
  args: string;
}

function parseProcessRows(raw: string): ProcessRow[] {
  return raw
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) {
        return undefined;
      }
      return {
        pid: Number(match[1]),
        command: match[2] ?? "",
        args: (match[3] ?? "").trim()
      };
    })
    .filter((row): row is ProcessRow => row !== undefined && Number.isFinite(row.pid));
}

export const toolDefinition: LeadAgentToolDefinition<typeof ProcessListToolInputSchema> = {
  name: "process_list",
  description: "List local processes for diagnostics and lifecycle control.",
  inputSchema: ProcessListToolInputSchema,
  inputHint: "Use with query filters before attempting process_stop.",
  async execute(input, _context) {
    const limit = input.limit ?? 40;
    const query = (input.query ?? "").toLowerCase();
    const { stdout } = await exec("ps -Ao pid,comm,args", { timeout: 8000, maxBuffer: 1024 * 512 });
    const rows = parseProcessRows(stdout);
    const filtered = query
      ? rows.filter((row) => row.command.toLowerCase().includes(query) || row.args.toLowerCase().includes(query))
      : rows;

    return {
      count: Math.min(limit, filtered.length),
      totalMatched: filtered.length,
      processes: filtered.slice(0, limit)
    };
  }
};
