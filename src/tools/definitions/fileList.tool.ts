import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LeadAgentToolDefinition } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";

export const FileListToolInputSchema = z.object({
  path: z.string().min(1).max(600).optional(),
  maxDepth: z.number().int().min(0).max(4).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  includeHidden: z.boolean().optional()
});

interface ListEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

async function listEntries(args: {
  root: string;
  projectRoot: string;
  maxDepth: number;
  limit: number;
  includeHidden: boolean;
}): Promise<ListEntry[]> {
  const output: ListEntry[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: args.root, depth: 0 }];

  while (queue.length > 0 && output.length < args.limit) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const entries = await readdir(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!args.includeHidden && entry.name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(current.dir, entry.name);
      const relative = toProjectRelative(args.projectRoot, absolute);
      if (entry.isDirectory()) {
        output.push({ path: relative, type: "dir" });
        if (current.depth < args.maxDepth) {
          queue.push({ dir: absolute, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        const fileStat = await stat(absolute);
        output.push({ path: relative, type: "file", sizeBytes: fileStat.size });
      }

      if (output.length >= args.limit) {
        break;
      }
    }
  }

  return output;
}

export const toolDefinition: LeadAgentToolDefinition<typeof FileListToolInputSchema> = {
  name: "file_list",
  description: "List files/directories inside the project root for navigation and planning edits.",
  inputSchema: FileListToolInputSchema,
  inputHint: "Use before reading/editing files to discover relevant paths safely.",
  async execute(input, context) {
    const rootPath = resolvePathInProject(context.projectRoot, input.path ?? ".");
    const maxDepth = input.maxDepth ?? 2;
    const limit = input.limit ?? 120;
    const includeHidden = input.includeHidden ?? false;
    const entries = await listEntries({
      root: rootPath,
      projectRoot: context.projectRoot,
      maxDepth,
      limit,
      includeHidden
    });
    return {
      root: toProjectRelative(context.projectRoot, rootPath),
      maxDepth,
      limit,
      includeHidden,
      count: entries.length,
      entries
    };
  }
};
