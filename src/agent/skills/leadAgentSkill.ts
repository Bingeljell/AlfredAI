import type { AgentSkillDefinition } from "./types.js";
import { resolveLeadAgentToolAllowlist } from "../toolPolicies.js";
import { runLeadAgenticLoop } from "../../core/runLeadAgenticLoop.js";

export const leadAgentSkill: AgentSkillDefinition = {
  name: "lead_agent",
  description: "Specialist agent for lead generation and enrichment workflows.",
  toolAllowlist: resolveLeadAgentToolAllowlist(),
  run(options) {
    return runLeadAgenticLoop({
      ...options,
      toolAllowlist: resolveLeadAgentToolAllowlist()
    });
  }
};
