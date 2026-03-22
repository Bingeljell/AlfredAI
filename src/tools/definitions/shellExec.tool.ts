import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";

const exec = promisify(execCallback);

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkillall\b/i,
  // Prevent reading .env files via shell utilities (secrets stay out of LLM context)
  /\b(cat|less|more|head|tail|grep|awk|sed)\b[^|]*\.env\b/i
];

export const ShellExecToolInputSchema = z.object({
  command: z.string().min(1).max(600),
  cwd: z.string().min(1).max(600).optional(),
  timeoutMs: z.number().int().min(500).max(30_000).optional()
});

function clipOutput(value: string, max = 6000): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n...[truncated]`;
}

export const toolDefinition: ToolDefinition<typeof ShellExecToolInputSchema> = {
  name: "shell_exec",
  description: "Execute a shell command in the project workspace (trusted mode only).",
  inputSchema: ShellExecToolInputSchema,
  inputHint: "Use for diagnostics and local workflow commands. Avoid destructive operations.",
  async execute(input, context) {
    if (context.policyMode !== "trusted") {
      return {
        blocked: true,
        reason: "shell_exec_blocked_in_balanced_mode"
      };
    }
    if (BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(input.command))) {
      return {
        blocked: true,
        reason: "blocked_by_safety_pattern"
      };
    }

    const cwdAbsolute = resolvePathInProject(context.projectRoot, input.cwd ?? ".");
    const timeoutMs = input.timeoutMs ?? 12_000;
    try {
      const result = await exec(input.command, {
        cwd: cwdAbsolute,
        timeout: timeoutMs,
        maxBuffer: 1024 * 512
      });
      return {
        blocked: false,
        cwd: toProjectRelative(context.projectRoot, cwdAbsolute),
        timeoutMs,
        success: true,
        stdout: clipOutput(result.stdout ?? ""),
        stderr: clipOutput(result.stderr ?? "")
      };
    } catch (error) {
      const typed = error as { code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
      return {
        blocked: false,
        cwd: toProjectRelative(context.projectRoot, cwdAbsolute),
        timeoutMs,
        success: false,
        code: typeof typed.code === "number" ? typed.code : undefined,
        signal: typeof typed.signal === "string" ? typed.signal : undefined,
        message: typeof typed.message === "string" ? typed.message.slice(0, 220) : "command_failed",
        stdout: clipOutput(typeof typed.stdout === "string" ? typed.stdout : ""),
        stderr: clipOutput(typeof typed.stderr === "string" ? typed.stderr : "")
      };
    }
  }
};
