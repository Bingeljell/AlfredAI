import type { RunOutcome } from "../types.js";
import { getAgentSkill } from "../agent/skills/registry.js";
import type { AgentSkillRunOptions } from "../agent/skills/types.js";

interface RunAgentLoopOptions extends AgentSkillRunOptions {
  skillName: string;
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunOutcome> {
  const skill = getAgentSkill(options.skillName);
  if (!skill) {
    return {
      status: "failed",
      assistantText: `Unknown agent skill: ${options.skillName}`
    };
  }

  return skill.run(options);
}
