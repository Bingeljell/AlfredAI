import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { DefaultHerdrReadOnlyClient } from "../../scheduler/probes/defaultHerdrClient.js";
import { HerdrAgentProbe } from "../../scheduler/probes/herdrAgentProbe.js";

export const HerdrStatusInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
  paneId: z.string().trim().min(1).max(256),
  agentName: z.string().trim().min(1).max(256).optional(),
}).strict();

export const toolDefinition: ToolDefinition<typeof HerdrStatusInputSchema> = {
  name: "herdr_status",
  description: "Read-only status probe for a Herdr agent workspace and pane; it cannot prompt or mutate the agent.",
  inputSchema: HerdrStatusInputSchema,
  inputHint: '{"workspaceId":"w1","paneId":"p1"}',
  async execute(input) {
    const result = await new HerdrAgentProbe(new DefaultHerdrReadOnlyClient()).probe({ type: "herdr_agent", ...input });
    return { status: result.status, summary: result.summary, digest: result.digest, terminal: result.terminal, changed: result.changed, errorCode: result.errorCode };
  },
};
