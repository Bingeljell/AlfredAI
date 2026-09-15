import type { EffectiveModelSelection, SessionModelSelection } from "../types.js";
import type { CodexModel, CodexRateLimitSnapshot, CodexRateLimitWindow, CodexSubscriptionService, CodexSubscriptionUsage } from "../provider/codex/subscriptionService.js";

export type SubscriptionChatService = Pick<CodexSubscriptionService, "listModels" | "readUsage" | "readRateLimits">;

export interface ModelCommandContext {
  preferences?: SessionModelSelection;
  globalModel: string;
}

export interface ModelSelectionResolution {
  selection: EffectiveModelSelection;
  model: CodexModel;
  nextPreferences?: SessionModelSelection;
}

export interface ParsedControlCommand {
  command: string;
  args: string[];
}

export function parseControlCommand(message: string): ParsedControlCommand | undefined {
  const parts = message.trim().split(/\s+/);
  const command = parts.shift()?.toLowerCase();
  if (!command?.startsWith("/")) return undefined;
  return { command, args: parts };
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function modelMatches(model: CodexModel, query: string): boolean {
  const needle = normalized(query);
  if (!needle) return false;
  const exact = [model.id, model.model, model.displayName].some((value) => normalized(value) === needle);
  if (exact) return true;
  if (needle.length < 2) return false;
  const aliases = `${model.id} ${model.model} ${model.displayName}`
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 2);
  return aliases.includes(needle);
}

export function findModelMatches(models: CodexModel[], query: string): CodexModel[] {
  return models.filter((model) => modelMatches(model, query));
}

export function findEffortMatches(model: CodexModel, query: string): Array<{ reasoningEffort: string; description: string }> {
  const needle = normalized(query);
  return model.supportedReasoningEfforts.filter((effort) =>
    normalized(effort.reasoningEffort) === needle || normalized(effort.description) === needle
  );
}

function defaultModel(models: CodexModel[], globalModel: string): CodexModel | undefined {
  return models.find((model) => normalized(model.id) === normalized(globalModel) || normalized(model.model) === normalized(globalModel))
    ?? models.find((model) => model.isDefault)
    ?? models[0];
}

export function resolveModelSelection(models: CodexModel[], context: ModelCommandContext): ModelSelectionResolution {
  const savedModel = context.preferences?.modelId;
  const selected = savedModel ? findModelMatches(models, savedModel).find((model) => normalized(model.id) === normalized(savedModel) || normalized(model.model) === normalized(savedModel)) : undefined;
  const model = selected ?? defaultModel(models, context.globalModel);
  if (!model) throw new Error("No visible models are available in the live Codex catalog");

  const noticeParts: string[] = [];
  let nextPreferences = context.preferences;
  if (savedModel && !selected) {
    noticeParts.push(`Your saved model ${savedModel} is no longer available; using ${model.displayName} (${model.id}).`);
    nextPreferences = { ...context.preferences, modelId: undefined };
  }

  const savedEffort = context.preferences?.reasoningEffort;
  const effortIsValid = Boolean(savedEffort && model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === savedEffort));
  const reasoningEffort = effortIsValid ? savedEffort : model.defaultReasoningEffort || model.supportedReasoningEfforts[0]?.reasoningEffort;
  if (savedEffort && !effortIsValid) {
    noticeParts.push(`Reasoning effort ${savedEffort} is not supported by ${model.displayName}; using ${reasoningEffort ?? "the model default"}.`);
    nextPreferences = { ...nextPreferences, reasoningEffort: undefined };
  }

  return {
    model,
    selection: {
      modelId: model.id,
      reasoningEffort,
      notice: noticeParts.length > 0 ? noticeParts.join(" ") : undefined
    },
    nextPreferences
  };
}

function pageNumber(args: string[]): number {
  if (args[0]?.toLowerCase() === "more") return 2;
  if (args[0]?.toLowerCase() === "page") {
    const parsed = Number(args[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  }
  return 1;
}

export function formatModelCommand(models: CodexModel[], context: ModelCommandContext, args: string[]): string {
  const resolution = resolveModelSelection(models, context);
  if (args.length > 0 && args[0].toLowerCase() !== "more" && args[0].toLowerCase() !== "page") {
    return "Use /model N, /model NAME, /model default, or /model page N.";
  }
  const page = pageNumber(args);
  const pageSize = 6;
  const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
  const visible = models.slice((page - 1) * pageSize, page * pageSize);
  if (visible.length === 0) return `Model page ${page} is empty. Choose a page from 1 to ${pageCount}.`;
  const lines = visible.map((model, index) => {
    const defaultLabel = model.isDefault ? " (default)" : "";
    const efforts = model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort).join(", ") || "none listed";
    return `${(page - 1) * pageSize + index + 1}. ${model.displayName} — ${model.id}${defaultLabel}; reasoning: ${efforts}`;
  });
  return [
    `Current model: ${resolution.model.displayName} (${resolution.model.id})${context.preferences?.modelId ? " [session override]" : " [global/default]"}`,
    `Models ${page}/${pageCount}:`,
    ...lines,
    page < pageCount ? `More: /model page ${page + 1}` : "",
    "Select with /model N or /model NAME. Reset with /model default."
  ].filter(Boolean).join("\n");
}

export function formatReasoningCommand(model: CodexModel, preferences: SessionModelSelection | undefined): string {
  const current = preferences?.reasoningEffort ?? model.defaultReasoningEffort ?? "model default";
  const lines = model.supportedReasoningEfforts.map((effort, index) => `${index + 1}. ${effort.reasoningEffort}${effort.description ? ` — ${effort.description}` : ""}`);
  return [
    `Current reasoning: ${current}${preferences?.reasoningEffort ? " [session override]" : " [model default]"}`,
    `Supported by ${model.displayName}:`,
    ...(lines.length > 0 ? lines : ["No reasoning efforts were listed by the live catalog."]),
    "Select with /reasoning N or /reasoning NAME. Reset with /reasoning default."
  ].join("\n");
}

function formatResetTime(unixSeconds: number | null): string {
  return unixSeconds ? `; resets ${new Date(unixSeconds * 1_000).toISOString()}` : "";
}

export function reachedRateLimit(snapshot: CodexRateLimitSnapshot): { bucket: string; resetAt: number | null; reachedType: string } | undefined {
  const buckets = Object.values(snapshot.buckets ?? {});
  const reached = [snapshot, ...buckets].find((bucket) => Boolean(bucket.reachedType));
  if (!reached?.reachedType) return undefined;
  return {
    bucket: reached.limitName ?? reached.limitId ?? "subscription quota",
    resetAt: reached.primary?.resetsAt ?? reached.secondary?.resetsAt ?? null,
    reachedType: reached.reachedType
  };
}

export function formatUsageCommand(usage: CodexSubscriptionUsage, localTokens: number): string {
  const rate = usage.rateLimits;
  const reached = reachedRateLimit(rate);
  const windows = ([
    ["primary", rate.primary],
    ["secondary", rate.secondary]
  ] as Array<[string, CodexRateLimitWindow | null]>).filter((entry): entry is [string, CodexRateLimitWindow] => Boolean(entry[1]))
    .map(([name, window]) => `${name}: ${window.usedPercent}% used${formatResetTime(window.resetsAt)}`);
  return [
    "ChatGPT subscription usage (authoritative App Server quota):",
    `Bucket: ${rate.limitName ?? rate.limitId ?? "unknown"}`,
    ...(windows.length > 0 ? windows : ["No quota window reported."]),
    reached ? `Reached: ${reached.reachedType} for ${reached.bucket}${formatResetTime(reached.resetAt)}` : "Reached: no",
    "",
    `Alfred local session token usage: ${localTokens} tokens (separate from subscription quota).`
  ].join("\n");
}
