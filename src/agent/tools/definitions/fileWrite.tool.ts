import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";

export const FileWriteToolInputSchema = z.object({
  path: z.string().min(1).max(600),
  content: z.string().max(250_000),
  mode: z.enum(["overwrite", "append"]).optional(),
  createDirs: z.boolean().optional()
});

export const toolDefinition: LeadAgentToolDefinition<typeof FileWriteToolInputSchema> = {
  name: "file_write",
  description: "Write or append text content to a file inside the project root.",
  inputSchema: FileWriteToolInputSchema,
  inputHint: "Use to create/update files after planning; keep writes scoped and reversible.",
  async execute(input, context) {
    const absolute = resolvePathInProject(context.projectRoot, input.path);
    const mode = input.mode ?? "overwrite";
    if (input.createDirs ?? true) {
      await mkdir(path.dirname(absolute), { recursive: true });
    }

    if (mode === "append") {
      await writeFile(absolute, input.content, { encoding: "utf8", flag: "a" });
    } else {
      await writeFile(absolute, input.content, { encoding: "utf8" });
    }

    return {
      path: toProjectRelative(context.projectRoot, absolute),
      mode,
      bytesWritten: Buffer.byteLength(input.content, "utf8")
    };
  }
};
