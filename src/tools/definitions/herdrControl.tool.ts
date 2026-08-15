import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const exec = promisify(execCallback);

export const HerdrControlInputSchema = z.object({
  action: z.enum([
    "list_agents",
    "list_workspaces",
    "capture_pane",
    "prompt_agent",
    "start_agent",
    "split_pane",
    "send_keys",
    "focus"
  ]),
  agentName: z.string().max(64).optional(),
  paneId: z.string().max(32).optional(),
  workspaceId: z.string().max(32).optional(),
  prompt: z.string().max(4000).optional(),
  agentKind: z.enum(["pi", "claude", "codex", "opencodeinterpreter"]).optional(),
  agentArgs: z.string().max(500).optional(),
  direction: z.enum(["right", "down"]).optional(),
  cwd: z.string().max(600).optional(),
  keys: z.string().max(500).optional(),
  tailLines: z.number().int().min(1).max(300).optional()
});

function clipOutput(value: string, max = 5000): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n...[truncated]`;
}

async function runHerdrCli(cmd: string, timeoutMs = 10_000): Promise<{ success: boolean; data?: any; raw?: string; error?: string }> {
  try {
    const result = await exec(`herdr ${cmd}`, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 512
    });
    const stdout = (result.stdout ?? "").trim();
    try {
      const parsed = JSON.parse(stdout);
      return { success: true, data: parsed };
    } catch {
      return { success: true, data: stdout, raw: stdout };
    }
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
      raw: err?.stderr || err?.stdout
    };
  }
}

export const toolDefinition: ToolDefinition<typeof HerdrControlInputSchema> = {
  name: "herdr_control",
  description: "Inspect, manage, and coordinate coding agents and terminals running in Herdr (Claude, Codex, Pi, etc.).",
  inputSchema: HerdrControlInputSchema,
  inputHint: '{"action": "list_agents"} or {"action": "capture_pane", "paneId": "w7:p1"} or {"action": "prompt_agent", "agentName": "pi", "prompt": "build..."}',
  async execute(input, _context) {
    switch (input.action) {
      case "list_agents": {
        const res = await runHerdrCli("agent list");
        if (!res.success) {
          return { error: `Failed to list agents: ${res.error}` };
        }
        return { success: true, agents: res.data };
      }

      case "list_workspaces": {
        const res = await runHerdrCli("workspace list");
        if (!res.success) {
          return { error: `Failed to list workspaces: ${res.error}` };
        }
        return { success: true, workspaces: res.data };
      }

      case "capture_pane": {
        const target = input.paneId ? `"${input.paneId}"` : (input.agentName ? `--agent "${input.agentName}"` : "");
        if (!target) {
          return { error: "capture_pane requires either paneId or agentName" };
        }
        const lines = input.tailLines ?? 80;
        const res = await runHerdrCli(`pane read ${target} --lines ${lines}`);
        if (!res.success) {
          return { error: `Failed to capture pane: ${res.error}`, raw: res.raw };
        }
        const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
        return {
          success: true,
          paneId: input.paneId,
          agentName: input.agentName,
          linesCaptured: lines,
          output: clipOutput(text)
        };
      }

      case "prompt_agent": {
        if (!input.agentName && !input.paneId) {
          return { error: "prompt_agent requires agentName or paneId" };
        }
        if (!input.prompt) {
          return { error: "prompt_agent requires a prompt string" };
        }
        const target = input.agentName ? `"${input.agentName}"` : `--pane "${input.paneId}"`;
        // Escape prompt safely for CLI execution
        const escapedPrompt = input.prompt.replace(/"/g, '\\"');
        const res = await runHerdrCli(`agent prompt ${target} "${escapedPrompt}"`, 15_000);
        if (!res.success) {
          return { error: `Failed to prompt agent: ${res.error}`, raw: res.raw };
        }
        return { success: true, target: input.agentName || input.paneId, response: res.data };
      }

      case "start_agent": {
        if (!input.agentName || !input.paneId || !input.agentKind) {
          return { error: "start_agent requires agentName, paneId, and agentKind (e.g. pi, claude, codex)" };
        }
        const extra = input.agentArgs ? ` -- ${input.agentArgs}` : "";
        const res = await runHerdrCli(`agent start "${input.agentName}" --kind "${input.agentKind}" --pane "${input.paneId}"${extra}`, 30_000);
        if (!res.success) {
          return { error: `Failed to start agent: ${res.error}`, raw: res.raw };
        }
        return { success: true, agentName: input.agentName, paneId: input.paneId, result: res.data };
      }

      case "split_pane": {
        const target = input.paneId ? `--pane "${input.paneId}"` : "";
        const dir = input.direction ? `--direction ${input.direction}` : "--direction right";
        const cwd = input.cwd ? `--cwd "${input.cwd}"` : "";
        const res = await runHerdrCli(`pane split ${target} ${dir} ${cwd} --no-focus`);
        if (!res.success) {
          return { error: `Failed to split pane: ${res.error}`, raw: res.raw };
        }
        return { success: true, result: res.data };
      }

      case "send_keys": {
        if (!input.paneId && !input.agentName) {
          return { error: "send_keys requires paneId or agentName" };
        }
        if (!input.keys) {
          return { error: "send_keys requires keys string" };
        }
        const target = input.paneId ? `--pane "${input.paneId}"` : `--agent "${input.agentName}"`;
        const escapedKeys = input.keys.replace(/"/g, '\\"');
        const res = await runHerdrCli(`pane send-keys ${target} "${escapedKeys}"`);
        if (!res.success) {
          return { error: `Failed to send keys: ${res.error}`, raw: res.raw };
        }
        return { success: true, result: res.data };
      }

      case "focus": {
        if (!input.paneId && !input.workspaceId) {
          return { error: "focus requires paneId or workspaceId" };
        }
        const cmd = input.paneId ? `pane focus --pane "${input.paneId}"` : `workspace focus --workspace "${input.workspaceId}"`;
        const res = await runHerdrCli(cmd);
        if (!res.success) {
          return { error: `Failed to focus: ${res.error}`, raw: res.raw };
        }
        return { success: true, result: res.data };
      }

      default:
        return { error: `Unsupported action: ${(input as any).action}` };
    }
  }
};
