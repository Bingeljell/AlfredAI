import { z } from "zod";
import { appConfig } from "../../config/env.js";
import { ExtensionManager } from "../../extensions/manager.js";
import { ExtensionManifestSchema } from "../../extensions/schema.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({
  name: ExtensionManifestSchema.shape.name,
  manifest: ExtensionManifestSchema,
  entrySource: z.string().min(1).max(250_000)
});

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "extension_write",
  description: "Create or update a disabled user-space Alfred extension. The exact code must still be reviewed and enabled by the user through the CLI.",
  inputSchema: InputSchema,
  inputHint: '{"name":"example_tool","manifest":{"schemaVersion":1,"name":"example_tool","version":"0.1.0","description":"Describe the tool","entry":"index.js","inputHint":"{}","alfredVersion":"0.1.x","capabilities":[]},"entrySource":"export async function execute(input) { return { ok: true }; }"}',
  requiresApproval: true,
  async execute(input) {
    const inspection = await new ExtensionManager(appConfig.extensionsDir).write(input.name, input.manifest, input.entrySource);
    return {
      name: inspection.manifest.name,
      version: inspection.manifest.version,
      digest: inspection.digest,
      capabilities: inspection.manifest.capabilities,
      enabled: false,
      nextStep: `Review the files, then run: alfred tools enable ${inspection.manifest.name} --yes`
    };
  }
};
