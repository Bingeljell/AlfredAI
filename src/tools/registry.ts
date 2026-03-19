import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LeadAgentToolContext, LeadAgentToolDefinition } from "./types.js";
import type { RunStore } from "../runs/runStore.js";
import { redactValue } from "../utils/redact.js";

interface ToolModule {
  toolDefinition?: LeadAgentToolDefinition;
}

export interface ToolExecutionEnvelope {
  tool: string;
  status: "ok" | "error";
  durationMs: number;
  requiresApproval: boolean;
  inputRepairApplied: boolean;
  inputRepairStrategy: string | null;
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

async function emitToolTraceEvent(
  args: ExecuteToolWithEnvelopeArgs,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await args.runStore.appendEvent({
    runId: args.runId,
    sessionId: args.context.sessionId,
    phase: "tool",
    eventType,
    payload: redactValue(payload) as Record<string, unknown>,
    timestamp: nowIso()
  });
}

interface ParsedToolInput {
  input: Record<string, unknown> | null;
  repaired: boolean;
  strategy: string | null;
}

function parseToolInputJson(toolName: string, inputJson: string): ParsedToolInput {
  const parsedDirect = parseJsonObjectCandidate(inputJson);
  if (parsedDirect) {
    const repaired = repairToolInputShape(toolName, parsedDirect);
    return {
      input: repaired.input,
      repaired: repaired.repaired,
      strategy: repaired.strategy
    };
  }

  const repaired = repairJsonLikeObject(inputJson);
  if (repaired) {
    const shapeRepaired = repairToolInputShape(toolName, repaired.input);
    return {
      input: shapeRepaired.input,
      repaired: true,
      strategy: shapeRepaired.repaired
        ? `${repaired.strategy}+${shapeRepaired.strategy ?? "tool_shape_repair"}`
        : repaired.strategy
    };
  }

  const coerced = coercePlainTextInput(toolName, inputJson);
  if (coerced) {
    return {
      input: coerced.input,
      repaired: true,
      strategy: coerced.strategy
    };
  }

  return {
    input: null,
    repaired: false,
    strategy: null
  };
}

function parseJsonObjectCandidate(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (typeof parsed === "string") {
      return parseJsonObjectCandidate(parsed);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stripMarkdownJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

function extractFirstObjectLikeBlock(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function normalizeUnicodeQuotes(text: string): string {
  return text
    .replaceAll("“", "\"")
    .replaceAll("”", "\"")
    .replaceAll("‘", "'")
    .replaceAll("’", "'");
}

function convertSingleQuotedJson(text: string): string {
  return text
    .replace(/([{,]\s*)'([^']+?)'\s*:/g, "$1\"$2\":")
    .replace(/:\s*'([^']*?)'(\s*[,}])/g, ": \"$1\"$2");
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function repairJsonLikeObject(inputJson: string): { input: Record<string, unknown>; strategy: string } | null {
  const candidates: Array<{ value: string; strategy: string }> = [];
  const trimmed = inputJson.trim();
  const deFenced = stripMarkdownJsonFence(trimmed);
  if (deFenced !== trimmed) {
    candidates.push({ value: deFenced, strategy: "strip_markdown_fence" });
  }
  const extracted = extractFirstObjectLikeBlock(deFenced);
  if (extracted && extracted !== deFenced) {
    candidates.push({ value: extracted, strategy: "extract_object_block" });
  }
  const normalizedQuotes = normalizeUnicodeQuotes(extracted ?? deFenced);
  if (normalizedQuotes !== (extracted ?? deFenced)) {
    candidates.push({ value: normalizedQuotes, strategy: "normalize_unicode_quotes" });
  }
  const singleQuoted = convertSingleQuotedJson(normalizedQuotes);
  if (singleQuoted !== normalizedQuotes) {
    candidates.push({ value: singleQuoted, strategy: "convert_single_quotes" });
  }
  const withoutTrailingCommas = stripTrailingCommas(singleQuoted);
  if (withoutTrailingCommas !== singleQuoted) {
    candidates.push({ value: withoutTrailingCommas, strategy: "strip_trailing_commas" });
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const parsed = parseJsonObjectCandidate(normalized);
    if (parsed) {
      return {
        input: parsed,
        strategy: candidate.strategy
      };
    }
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function firstStringInArray(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const item of value) {
    const parsed = asNonEmptyString(item);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function extractHttpUrlCandidate(value: string): string | null {
  const matched = value.match(/https?:\/\/[^\s"'`>,)]+/i)?.[0];
  if (!matched) {
    return null;
  }
  let candidate = matched.replace(/[>\]"'`),]+$/g, "");
  candidate = candidate.replace(/(?:%22|%27|%2C)+$/gi, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function isSearchFamilyTool(toolName: string): boolean {
  return toolName === "search" || toolName === "lead_search_shortlist";
}

function pickSearchQuery(input: Record<string, unknown>): string | null {
  const direct = asNonEmptyString(input.query);
  if (direct) {
    return direct;
  }
  const fromQueries = firstStringInArray(input.queries);
  if (fromQueries) {
    return fromQueries;
  }
  const aliasKeys = ["instruction", "brief", "prompt", "objective", "message", "task", "keyword"];
  for (const key of aliasKeys) {
    const parsed = asNonEmptyString(input[key]);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function repairSearchFamilyInput(
  toolName: string,
  input: Record<string, unknown>
): { input: Record<string, unknown>; repaired: boolean; strategy: string | null } {
  const next = { ...input };
  const strategies: string[] = [];
  const query = pickSearchQuery(next);
  if (query && next.query !== query) {
    next.query = query;
    strategies.push("tool_shape_repair_query");
  }

  const maxResults = asPositiveInteger(next.maxResults)
    ?? asPositiveInteger(next.numResults)
    ?? asPositiveInteger(next.top_k);
  if (maxResults && next.maxResults !== maxResults) {
    next.maxResults = maxResults;
    strategies.push("tool_shape_repair_max_results");
  }

  if (toolName === "lead_search_shortlist") {
    const maxUrls = asPositiveInteger(next.maxUrls) ?? asPositiveInteger(next.urlLimit);
    if (maxUrls && next.maxUrls !== maxUrls) {
      next.maxUrls = maxUrls;
      strategies.push("tool_shape_repair_max_urls");
    }
  }

  return {
    input: next,
    repaired: strategies.length > 0,
    strategy: strategies.length > 0 ? strategies.join("+") : null
  };
}

function repairWriterAgentInput(input: Record<string, unknown>): {
  input: Record<string, unknown>;
  repaired: boolean;
  strategy: string | null;
} {
  const next = { ...input };
  const strategies: string[] = [];
  const instruction =
    asNonEmptyString(next.instruction)
    ?? asNonEmptyString(next.brief)
    ?? asNonEmptyString(next.prompt)
    ?? asNonEmptyString(next.objective)
    ?? asNonEmptyString(next.message)
    ?? asNonEmptyString(next.task)
    ?? asNonEmptyString(next.query);
  if (instruction && next.instruction !== instruction) {
    next.instruction = instruction;
    strategies.push("tool_shape_repair_instruction");
  }

  const maxWords = asPositiveInteger(next.maxWords) ?? asPositiveInteger(next.max_words) ?? asPositiveInteger(next.wordLimit);
  if (maxWords && next.maxWords !== maxWords) {
    next.maxWords = maxWords;
    strategies.push("tool_shape_repair_max_words");
  }

  const outputPath = asNonEmptyString(next.outputPath) ?? asNonEmptyString(next.path) ?? asNonEmptyString(next.filePath);
  if (outputPath && next.outputPath !== outputPath) {
    next.outputPath = outputPath;
    strategies.push("tool_shape_repair_output_path");
  }

  const normalizedFormat = (() => {
    const raw = asNonEmptyString(next.format);
    if (!raw) {
      return null;
    }
    const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_");
    const aliases: Record<string, string> = {
      blog: "blog_post",
      blogpost: "blog_post",
      blog_post: "blog_post",
      blog_article: "blog_post",
      article: "blog_post",
      news: "blog_post",
      news_article: "blog_post",
      memo: "memo",
      email: "email",
      outline: "outline",
      social: "social_post",
      social_post: "social_post",
      note: "notes",
      notes: "notes"
    };
    return aliases[normalized] ?? null;
  })();
  if (normalizedFormat && next.format !== normalizedFormat) {
    next.format = normalizedFormat;
    strategies.push("tool_shape_repair_format");
  }

  return {
    input: next,
    repaired: strategies.length > 0,
    strategy: strategies.length > 0 ? strategies.join("+") : null
  };
}

function repairWebFetchInput(input: Record<string, unknown>): {
  input: Record<string, unknown>;
  repaired: boolean;
  strategy: string | null;
} {
  const next = { ...input };
  const strategies: string[] = [];
  const query =
    asNonEmptyString(next.query)
    ?? firstStringInArray(next.queries)
    ?? asNonEmptyString(next.instruction)
    ?? asNonEmptyString(next.brief)
    ?? asNonEmptyString(next.prompt)
    ?? asNonEmptyString(next.objective)
    ?? asNonEmptyString(next.message)
    ?? asNonEmptyString(next.task);
  if (query && next.query !== query) {
    next.query = query;
    strategies.push("tool_shape_repair_query");
  }

  if (Array.isArray(next.urls)) {
    const normalizedUrls = Array.from(
      new Set(
        next.urls
          .map((item) => (typeof item === "string" ? extractHttpUrlCandidate(item) : null))
          .filter((item): item is string => Boolean(item))
      )
    );
    if (
      normalizedUrls.length > 0 &&
      (next.urls.length !== normalizedUrls.length || next.urls.some((item, index) => item !== normalizedUrls[index]))
    ) {
      next.urls = normalizedUrls;
      strategies.push("tool_shape_repair_urls");
    }
  }

  const useStoredUrls =
    asBoolean(next.useStoredUrls)
    ?? asBoolean(next.useStored)
    ?? asBoolean(next.useStoredShortlist)
    ?? null;
  if (useStoredUrls !== null && next.useStoredUrls !== useStoredUrls) {
    next.useStoredUrls = useStoredUrls;
    strategies.push("tool_shape_repair_use_stored_urls");
  }

  const maxPages = asPositiveInteger(next.maxPages) ?? asPositiveInteger(next.pageLimit);
  if (maxPages && next.maxPages !== maxPages) {
    next.maxPages = maxPages;
    strategies.push("tool_shape_repair_max_pages");
  }

  const maxResults = asPositiveInteger(next.maxResults) ?? asPositiveInteger(next.numResults) ?? asPositiveInteger(next.top_k);
  if (maxResults && next.maxResults !== maxResults) {
    next.maxResults = maxResults;
    strategies.push("tool_shape_repair_max_results");
  }

  const browseConcurrency =
    asPositiveInteger(next.browseConcurrency)
    ?? asPositiveInteger(next.concurrency)
    ?? asPositiveInteger(next.parallelism);
  if (browseConcurrency && next.browseConcurrency !== browseConcurrency) {
    next.browseConcurrency = browseConcurrency;
    strategies.push("tool_shape_repair_browse_concurrency");
  }

  return {
    input: next,
    repaired: strategies.length > 0,
    strategy: strategies.length > 0 ? strategies.join("+") : null
  };
}

function repairToolInputShape(
  toolName: string,
  input: Record<string, unknown>
): { input: Record<string, unknown>; repaired: boolean; strategy: string | null } {
  if (isSearchFamilyTool(toolName)) {
    return repairSearchFamilyInput(toolName, input);
  }
  if (toolName === "web_fetch") {
    return repairWebFetchInput(input);
  }
  if (toolName === "writer_agent" || toolName === "article_writer") {
    return repairWriterAgentInput(input);
  }
  return {
    input,
    repaired: false,
    strategy: null
  };
}

function coercePlainTextInput(
  toolName: string,
  inputJson: string
): { input: Record<string, unknown>; strategy: string } | null {
  const normalized = inputJson.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("{") || normalized.startsWith("[") || normalized.startsWith("`")) {
    return null;
  }

  if (isSearchFamilyTool(toolName)) {
    return {
      input: {
        query: normalized
      },
      strategy: "coerce_plain_query"
    };
  }
  if (toolName === "writer_agent" || toolName === "article_writer") {
    return {
      input: {
        instruction: normalized
      },
      strategy: "coerce_plain_instruction"
    };
  }
  return null;
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
    // Backward-compatible alias while migrating away from writer_agent naming.
    if (definition.name === "writer_agent") {
      toolMap.set("article_writer", {
        ...definition,
        name: "article_writer",
        description: definition.description.replace("writer_agent", "article_writer")
      });
    }
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
  await emitToolTraceEvent(args, "tool_action_started", {
    toolName: args.toolName,
    inputJson: args.inputJson
  });
  if (!tool) {
    await emitToolTraceEvent(args, "tool_action_rejected", {
      toolName: args.toolName,
      reason: "tool_not_available"
    });
    return {
      tool: args.toolName,
      status: "error",
      durationMs: Date.now() - started,
      requiresApproval: false,
      inputRepairApplied: false,
      inputRepairStrategy: null,
      input: null,
      result: null,
      error: "tool_not_available"
    };
  }

  const requiresApproval = tool.requiresApproval === true;
  const parsedInputJson = parseToolInputJson(args.toolName, args.inputJson);
  const rawInput = parsedInputJson.input;
  if (!rawInput) {
    await emitToolTraceEvent(args, "tool_action_rejected", {
      toolName: args.toolName,
      reason: "invalid_input_json",
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy
    });
    return {
      tool: args.toolName,
      status: "error",
      durationMs: Date.now() - started,
      requiresApproval,
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy,
      input: null,
      result: null,
      error: "invalid_input_json"
    };
  }

  const parsedInput = tool.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    await emitToolTraceEvent(args, "tool_action_rejected", {
      toolName: args.toolName,
      reason: "tool_schema_validation_failed",
      input: rawInput,
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy,
      error: parsedInput.error.message.slice(0, 200)
    });
    return {
      tool: args.toolName,
      status: "error",
      durationMs: Date.now() - started,
      requiresApproval,
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy,
      input: rawInput,
      result: null,
      error: `tool_schema_validation_failed: ${parsedInput.error.message.slice(0, 200)}`
    };
  }

  if (requiresApproval) {
    await emitToolTraceEvent(args, "tool_action_rejected", {
      toolName: args.toolName,
      reason: "approval_required_not_supported",
      input: rawInput
    });
    return {
      tool: args.toolName,
      status: "error",
      durationMs: Date.now() - started,
      requiresApproval: true,
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy,
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
    await emitToolTraceEvent(args, "tool_action_completed", {
      toolName: args.toolName,
      durationMs,
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy,
      input: parsedInput.data,
      output
    });
    return {
      tool: args.toolName,
      status: "ok",
      durationMs,
      requiresApproval: false,
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy,
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
    await emitToolTraceEvent(args, "tool_action_failed", {
      toolName: args.toolName,
      durationMs,
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy,
      input: parsedInput.data,
      error: errorMessage
    });
    return {
      tool: args.toolName,
      status: "error",
      durationMs,
      requiresApproval: false,
      inputRepairApplied: parsedInputJson.repaired,
      inputRepairStrategy: parsedInputJson.strategy,
      input: rawInput,
      result: null,
      error: errorMessage
    };
  }
}
