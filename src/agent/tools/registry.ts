import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LeadAgentToolContext, LeadAgentToolDefinition } from "../types.js";
import type { RunStore } from "../../runs/runStore.js";
import { redactValue } from "../../utils/redact.js";

interface ToolModule {
  toolDefinition?: LeadAgentToolDefinition;
}

export interface ToolExecutionEnvelope {
  tool: string;
  status: "ok" | "error";
  durationMs: number;
  requiresApproval: boolean;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

interface ExecuteToolWithEnvelopeArgs {
  toolName: string;
  inputJson: string;
  tools: Map<string, LeadAgentToolDefinition>;
  context: LeadAgentToolContext;
  runStore: RunStore;
  runId: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseToolInputJson(inputJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function definitionsDir(): string {
  const filePath = fileURLToPath(import.meta.url);
  return path.join(path.dirname(filePath), "definitions");
}

export async function discoverLeadAgentTools(): Promise<Map<string, LeadAgentToolDefinition>> {
  const toolMap = new Map<string, LeadAgentToolDefinition>();
  const dirPath = definitionsDir();
  const entries = await readdir(dirPath);

  const toolFiles = entries
    .filter((entry) => /\.tool\.(ts|js)$/.test(entry))
    .sort((a, b) => a.localeCompare(b));

  for (const file of toolFiles) {
    const modulePath = path.join(dirPath, file);
    const moduleUrl = pathToFileURL(modulePath).href;
    const loaded = (await import(moduleUrl)) as ToolModule;
    const definition = loaded.toolDefinition;
    if (!definition) {
      continue;
    }
    toolMap.set(definition.name, definition);
  }

  return toolMap;
}

export function applyToolAllowlist(
  toolMap: Map<string, LeadAgentToolDefinition>,
  allowlist: string[] | undefined
): Map<string, LeadAgentToolDefinition> {
  const normalizedAllowlist = allowlist?.map((item) => item.trim()).filter(Boolean);
  if (!normalizedAllowlist || normalizedAllowlist.length === 0) {
    return toolMap;
  }

  return new Map(Array.from(toolMap.entries()).filter(([name]) => normalizedAllowlist.includes(name)));
}

export async function executeToolWithEnvelope(args: ExecuteToolWithEnvelopeArgs): Promise<ToolExecutionEnvelope> {
  const started = Date.now();
  const tool = args.tools.get(args.toolName);
  if (!tool) {
    return {
      tool: args.toolName,
      status: "error",
      durationMs: Date.now() - started,
      requiresApproval: false,
      input: null,
      result: null,
      error: "tool_not_available"
    };
  }

  const requiresApproval = tool.requiresApproval === true;
  const rawInput = parseToolInputJson(args.inputJson);
  if (!rawInput) {
    return {
      tool: args.toolName,
      status: "error",
      durationMs: Date.now() - started,
      requiresApproval,
      input: null,
      result: null,
      error: "invalid_input_json"
    };
  }

  const parsedInput = tool.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return {
      tool: args.toolName,
      status: "error",
      durationMs: Date.now() - started,
      requiresApproval,
      input: rawInput,
      result: null,
      error: `tool_schema_validation_failed: ${parsedInput.error.message.slice(0, 200)}`
    };
  }

  if (requiresApproval) {
    return {
      tool: args.toolName,
      status: "error",
      durationMs: Date.now() - started,
      requiresApproval: true,
      input: rawInput,
      result: null,
      error: "approval_required_not_supported"
    };
  }

  try {
    const output = await tool.execute(parsedInput.data, args.context);
    const outputRecord = output as Record<string, unknown>;
    const durationMs = Date.now() - started;
    await args.runStore.addToolCall(args.runId, {
      toolName: args.toolName,
      inputRedacted: redactValue(parsedInput.data),
      outputRedacted: redactValue(output),
      durationMs,
      status: "ok",
      timestamp: nowIso()
    });
    return {
      tool: args.toolName,
      status: "ok",
      durationMs,
      requiresApproval: false,
      input: rawInput,
      result: outputRecord,
      error: null
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const errorMessage = error instanceof Error ? error.message.slice(0, 220) : "tool_execution_failed";
    await args.runStore.addToolCall(args.runId, {
      toolName: args.toolName,
      inputRedacted: redactValue(parsedInput.data),
      outputRedacted: { error: errorMessage },
      durationMs,
      status: "error",
      timestamp: nowIso()
    });
    return {
      tool: args.toolName,
      status: "error",
      durationMs,
      requiresApproval: false,
      input: rawInput,
      result: null,
      error: errorMessage
    };
  }
}
