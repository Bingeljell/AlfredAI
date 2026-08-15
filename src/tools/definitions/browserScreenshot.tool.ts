import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { browserSessions, defaultScreenshotName } from "../browser/browserController.js";

const InputSchema = z.object({
  name: z.string().regex(/^[\w.-]{1,80}$/).optional(),
  fullPage: z.boolean().optional()
});

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "browser_screenshot",
  description:
    "Capture the current page of Alfred's persistent browser as a PNG saved under the workspace. Returns the saved file path; the file is also registered as a run artifact.",
  inputSchema: InputSchema,
  inputHint: '{"name": "checkout-step-2"}',
  async execute(input, context) {
    try {
      const controller = await browserSessions.forSession(context.sessionId);
      const outputDir = path.join(context.workspaceDir, "browser", "screenshots");
      const fileName = defaultScreenshotName(Date.now(), input.name);
      const result = await controller.screenshot(outputDir, fileName, input.fullPage ?? false);
      context.addArtifact(result.filePath);
      return {
        filePath: result.filePath,
        bytes: result.bytes,
        fullPage: input.fullPage ?? false
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "browser_screenshot_failed" };
    }
  }
};
