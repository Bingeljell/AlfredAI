import type { CodexJsonObject } from "./types.js";

export const CODEX_APP_SERVER_GATE_TOOL = {
  type: "function" as const,
  name: "alfred_gate_probe",
  description: "A no-op capability-gate probe owned and executed by Alfred.",
  inputSchema: {
    type: "object",
    properties: {
      value: { type: "string" }
    },
    required: ["value"],
    additionalProperties: false
  }
};

export const CODEX_APP_SERVER_GATE_VALUE = "alfred-gate-ok";

export interface AppServerDynamicToolCall {
  callId: string;
  namespace?: string | null;
  tool: string;
  arguments: unknown;
  threadId?: string;
  turnId?: string;
}

export interface GateToolValidation {
  ok: boolean;
  reason?: string;
  value?: string;
}

export interface CapabilityGateThreadParams extends CodexJsonObject {
  ephemeral: true;
  model?: string | null;
  dynamicTools: [typeof CODEX_APP_SERVER_GATE_TOOL];
  environments: [];
  runtimeWorkspaceRoots: [];
  sandbox: "read-only";
  approvalPolicy: "never";
  baseInstructions: string;
}

export interface CapabilityGateTurnParams extends CodexJsonObject {
  threadId: string;
  input: [{ type: "text"; text: string }];
  environments: [];
  runtimeWorkspaceRoots: [];
  sandboxPolicy: { type: "readOnly"; networkAccess: false };
  approvalPolicy: "never";
  model?: string | null;
}

export const CODEX_APP_SERVER_GATE_INSTRUCTIONS = [
  "This is a capability-gate test.",
  "Call the Alfred dynamic tool alfred_gate_probe exactly once with JSON arguments {value: \"alfred-gate-ok\"}.",
  "Do not invoke shell, filesystem, apply_patch, browser, web search, network, MCP, or any other built-in or external capability.",
  "After the tool result, answer with a short confirmation."
].join(" ");

export function buildCapabilityGateThreadParams(model?: string): CapabilityGateThreadParams {
  return {
    ephemeral: true,
    model: model ?? null,
    dynamicTools: [CODEX_APP_SERVER_GATE_TOOL],
    environments: [],
    runtimeWorkspaceRoots: [],
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: CODEX_APP_SERVER_GATE_INSTRUCTIONS
  };
}

export function buildCapabilityGateTurnParams(threadId: string, model?: string): CapabilityGateTurnParams {
  return {
    threadId,
    input: [{ type: "text", text: CODEX_APP_SERVER_GATE_INSTRUCTIONS }],
    environments: [],
    runtimeWorkspaceRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalPolicy: "never",
    model: model ?? null
  };
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function validateGateDynamicToolCall(call: AppServerDynamicToolCall): GateToolValidation {
  if (call.tool !== CODEX_APP_SERVER_GATE_TOOL.name) {
    return { ok: false, reason: `unknown dynamic tool: ${call.tool}` };
  }

  const args = parseArguments(call.arguments);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "dynamic tool arguments must be a JSON object" };
  }

  const entries = Object.entries(args);
  if (entries.length !== 1 || typeof (args as Record<string, unknown>).value !== "string") {
    return { ok: false, reason: "dynamic tool arguments must contain only string field value" };
  }

  const value = (args as Record<string, unknown>).value;
  if (value !== CODEX_APP_SERVER_GATE_VALUE) {
    return { ok: false, reason: `unexpected probe value: ${value}` };
  }

  return { ok: true, value };
}

const SAFE_REJECTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "applyPatchApproval",
  "execCommandApproval",
  "thread/shellCommand"
]);

export function classifyCapabilityGateServerRequest(method: string): "dynamic_tool" | "safe_rejection" | "unexpected" {
  if (method === "item/tool/call") return "dynamic_tool";
  if (SAFE_REJECTION_METHODS.has(method)) return "safe_rejection";
  return "unexpected";
}
