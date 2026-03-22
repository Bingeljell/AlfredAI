import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";

export const FileReadToolInputSchema = z.object({
  path: z.string().min(1).max(600),
  startLine: z.number().int().min(1).max(1_000_000).optional(),
  maxLines: z.number().int().min(1).max(800).optional(),
  maxChars: z.number().int().min(200).max(80_000).optional()
});

const BLOCKED_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,       // .env, .env.local, .env.production, etc.
  /\.pem$/i,                // TLS certificates
  /\.key$/i,                // private keys
  /\.(p12|pfx)$/i,          // PKCS12 bundles
  /\.secret$/i              // generic secret files
];

export const toolDefinition: ToolDefinition<typeof FileReadToolInputSchema> = {
  name: "file_read",
  description: "Read text file content from the project root with bounded slices.",
  inputSchema: FileReadToolInputSchema,
  inputHint: "Use for precise context gathering before making edits.",
  async execute(input, context) {
    const absolute = resolvePathInProject(context.projectRoot, input.path);
    const basename = absolute.split("/").pop() ?? "";
    if (BLOCKED_FILE_PATTERNS.some(p => p.test(basename))) {
      return { blocked: true, reason: "sensitive_file_blocked", path: input.path };
    }
    const raw = await readFile(absolute, "utf8");
    if (raw.includes("\u0000")) {
      throw new Error("file appears to be binary and cannot be read as text");
    }

    const startLine = input.startLine ?? 1;
    const maxLines = input.maxLines ?? 250;
    const maxChars = input.maxChars ?? 20_000;
    const lines = raw.split("\n");
    const startIndex = Math.max(0, startLine - 1);
    const endIndex = Math.min(lines.length, startIndex + maxLines);
    const selected = lines.slice(startIndex, endIndex).join("\n");
    const truncatedByChars = selected.length > maxChars;
    const content = truncatedByChars ? selected.slice(0, maxChars) : selected;

    return {
      path: toProjectRelative(context.projectRoot, absolute),
      startLine,
      lineCount: Math.max(0, endIndex - startIndex),
      totalLines: lines.length,
      maxLines,
      maxChars,
      truncatedByChars,
      content
    };
  }
};
