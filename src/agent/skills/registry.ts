import type { AgentSkillDefinition } from "./types.js";
import { leadAgentSkill } from "./leadAgentSkill.js";

const SKILLS: AgentSkillDefinition[] = [leadAgentSkill];

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
