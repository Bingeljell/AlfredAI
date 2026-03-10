import type { AgentSkillDefinition } from "./types.js";
import { resolveOpsAgentToolAllowlist } from "../toolPolicies.js";
import { runSpecialistToolLoop } from "../../core/runSpecialistToolLoop.js";

const OPS_AGENT_SYSTEM_PROMPT = `
You are ops_agent, Alfred's specialist for local project operations.

Responsibilities:
- Inspect files and process state before making changes.
- Use shell/process tools only when necessary and keep actions reversible.
- Prefer precise file edits over broad destructive operations.
- Report exact commands/results and highlight blockers clearly.

Execution style:
- Plan -> act -> observe -> replan.
- For multi-step tasks, checkpoint output paths and command outcomes.
- If constraints block execution, explain what is needed next.
`.trim();

export const opsAgentSkill: AgentSkillDefinition = {
  name: "ops_agent",
  description: "Specialist for local file/process/shell operations.",
  toolAllowlist: resolveOpsAgentToolAllowlist(),
  run(options) {
    return runSpecialistToolLoop({
      ...options,
      skillName: "ops_agent",
      skillDescription: "local operations specialist",
      skillSystemPrompt: OPS_AGENT_SYSTEM_PROMPT,
      toolAllowlist: resolveOpsAgentToolAllowlist()
    });
  }
};
