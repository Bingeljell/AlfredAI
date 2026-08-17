import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { FileExistsProbe } from "../../scheduler/probes/fileExistsProbe.js";

export const FileExistsInputSchema = z.object({ relativePath: z.string().min(1).max(512) }).strict();

export const toolDefinition: ToolDefinition<typeof FileExistsInputSchema> = {
  name: "file_exists",
  description: "Check whether a safe workspace-relative file exists for a bounded scheduled task.",
  inputSchema: FileExistsInputSchema,
  inputHint: '{"relativePath":"workspace/result.md"}',
  async execute(input, context) {
    const result = await new FileExistsProbe(context.workspaceDir).probe({ type: "file_exists", relativePath: input.relativePath });
    return { status: result.status, summary: result.summary, digest: result.digest, terminal: result.terminal, changed: result.changed, errorCode: result.errorCode };
  },
};

