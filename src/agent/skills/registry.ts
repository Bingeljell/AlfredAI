import type { AgentSkillDefinition } from "./types.js";
import { leadAgentSkill } from "./leadAgentSkill.js";
import { researchAgentSkill } from "./researchAgentSkill.js";
import { opsAgentSkill } from "./opsAgentSkill.js";

const SKILLS: AgentSkillDefinition[] = [leadAgentSkill, researchAgentSkill, opsAgentSkill];

export function listAgentSkills(): AgentSkillDefinition[] {
  return [...SKILLS];
}

export function getAgentSkill(name: string | undefined): AgentSkillDefinition | undefined {
  const normalized = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!normalized) {
    return undefined;
  }
  return SKILLS.find((skill) => skill.name === normalized);
}
