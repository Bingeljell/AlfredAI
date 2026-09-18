import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";
import { toolApprovalActionKey, toolApprovalStore } from "../../runtime/toolApprovalStore.js";

const exec = promisify(execCallback);

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
  description: "Execute a shell command in the project workspace, subject to the configured access mode.",
  inputSchema: ShellExecToolInputSchema,
  inputHint: "Use for diagnostics and local workflow commands. Avoid destructive operations.",
  async execute(input, context) {
    if (context.policyMode === "limited") {
      return {
        blocked: true,
        reason: "shell_exec_disabled_in_limited_mode"
      };
    }
    if (context.policyMode === "balanced") {
      const actionKey = toolApprovalActionKey("shell_exec", { command: input.command, cwd: input.cwd ?? ".", timeoutMs: input.timeoutMs ?? 12_000 });
      if (!toolApprovalStore.consume(context.sessionId, actionKey)) {
        const approval = toolApprovalStore.request(context.sessionId, actionKey, `shell_exec: ${input.command}`);
        return {
          blocked: true,
          reason: "approval_required",
          approvalToken: approval.token,
          command: input.command,
          expiresAt: approval.expiresAt,
          nextStep: `Send /approve ${approval.token}, then ask Alfred to retry the same command.`
        };
      }
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
