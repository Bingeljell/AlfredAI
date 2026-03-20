import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";

export const FileEditToolInputSchema = z.object({
  path: z.string().min(1).max(600),
  find: z.string().min(1).max(5000),
  replace: z.string().max(5000),
  replaceAll: z.boolean().optional()
});

function countMatches(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) {
      break;
    }
    count += 1;
    index = found + needle.length;
  }
  return count;
}

export const toolDefinition: ToolDefinition<typeof FileEditToolInputSchema> = {
  name: "file_edit",
  description: "Perform text replacement edits in an existing file.",
  inputSchema: FileEditToolInputSchema,
  inputHint: "Use for precise in-file edits when a direct find/replace is sufficient.",
  async execute(input, context) {
    const absolute = resolvePathInProject(context.projectRoot, input.path);
    const original = await readFile(absolute, "utf8");
    const matchCount = countMatches(original, input.find);
    if (matchCount === 0) {
      return {
        path: toProjectRelative(context.projectRoot, absolute),
        matched: 0,
        replaced: 0,
        changed: false
      };
    }

    const replaceAll = input.replaceAll ?? false;
    const next = replaceAll ? original.split(input.find).join(input.replace) : original.replace(input.find, input.replace);
    await writeFile(absolute, next, "utf8");

    return {
      path: toProjectRelative(context.projectRoot, absolute),
      matched: matchCount,
      replaced: replaceAll ? matchCount : 1,
      changed: next !== original
    };
  }
};
