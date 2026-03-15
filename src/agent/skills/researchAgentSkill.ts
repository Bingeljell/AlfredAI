import type { AgentSkillDefinition } from "./types.js";
import { resolveResearchAgentToolAllowlist } from "../toolPolicies.js";
import { runSpecialistToolLoop } from "../../core/runSpecialistToolLoop.js";

const RESEARCH_AGENT_SYSTEM_PROMPT = `
You are research_agent, Alfred's specialist for web research and content drafting.

Responsibilities:
- Gather evidence from web and local docs using available tools.
- Synthesize results into concise, useful outputs.
- When asked to draft content, use article_writer after gathering source material.
- If output should be saved, use file_write after article_writer returns a complete draft.

Execution style:
- Plan -> act -> observe -> replan.
- Prefer high-signal actions over repeated diagnostics.
- Be explicit when sources are weak or missing.
`.trim();

export const researchAgentSkill: AgentSkillDefinition = {
  name: "research_agent",
  description: "Specialist for web research, synthesis, and drafting.",
  toolAllowlist: resolveResearchAgentToolAllowlist(),
  run(options) {
    return runSpecialistToolLoop({
      ...options,
      skillName: "research_agent",
      skillDescription: "web research and writing specialist",
      skillSystemPrompt: RESEARCH_AGENT_SYSTEM_PROMPT,
      toolAllowlist: resolveResearchAgentToolAllowlist()
    });
  }
};
