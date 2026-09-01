import type { AccountClient } from "./accountService.js";

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  inputModalities: string[];
}

export interface CodexProviderCapabilities {
  imageGeneration: boolean;
  namespaceTools: boolean;
  webSearch: boolean;
}

export interface CodexModelCatalog {
  models: CodexModel[];
  capabilities: CodexProviderCapabilities;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  reachedType: string | null;
  credits: { balance: string | null; hasCredits: boolean; unlimited: boolean } | null;
  buckets?: Record<string, CodexRateLimitSnapshot>;
}

export interface CodexUsageSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  longestRunningTurnSec: number | null;
}

export interface CodexUsageBucket {
  startDate: string;
  tokens: number;
}

export interface CodexSubscriptionUsage {
  rateLimits: CodexRateLimitSnapshot;
  usage: {
    summary: CodexUsageSummary;
    dailyUsageBuckets: CodexUsageBucket[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapModel(value: unknown): CodexModel | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id || value.model);
  if (!id) return null;
  const efforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.filter(isRecord).map((effort) => ({
        reasoningEffort: asString(effort.reasoningEffort),
        description: asString(effort.description)
      })).filter((effort) => effort.reasoningEffort)
    : [];
  return {
    id,
    model: asString(value.model, id),
    displayName: asString(value.displayName, id),
    description: asString(value.description),
    hidden: asBoolean(value.hidden),
    isDefault: asBoolean(value.isDefault),
    defaultReasoningEffort: asString(value.defaultReasoningEffort),
    supportedReasoningEfforts: efforts,
    inputModalities: Array.isArray(value.inputModalities) ? value.inputModalities.filter((item): item is string => typeof item === "string") : ["text", "image"]
  };
}

function mapRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent) ? value.usedPercent : 0;
  return {
    usedPercent,
    resetsAt: asNumberOrNull(value.resetsAt),
    windowDurationMins: asNumberOrNull(value.windowDurationMins)
  };
}

function mapRateLimit(value: unknown): CodexRateLimitSnapshot {
  const body = isRecord(value) ? value : {};
  const creditsBody = isRecord(body.credits) ? body.credits : undefined;
  const snapshot: CodexRateLimitSnapshot = {
    limitId: typeof body.limitId === "string" ? body.limitId : null,
    limitName: typeof body.limitName === "string" ? body.limitName : null,
    planType: typeof body.planType === "string" ? body.planType : null,
    primary: mapRateLimitWindow(body.primary),
    secondary: mapRateLimitWindow(body.secondary),
    reachedType: typeof body.rateLimitReachedType === "string" ? body.rateLimitReachedType : null,
    credits: creditsBody ? {
      balance: typeof creditsBody.balance === "string" ? creditsBody.balance : null,
      hasCredits: asBoolean(creditsBody.hasCredits),
      unlimited: asBoolean(creditsBody.unlimited)
    } : null
  };
  const byLimitId = isRecord(body.rateLimitsByLimitId) ? body.rateLimitsByLimitId : undefined;
  if (byLimitId) {
    snapshot.buckets = Object.fromEntries(Object.entries(byLimitId)
      .map(([id, bucket]) => [id, mapRateLimit(bucket)] as const));
  }
  return snapshot;
}

function mapUsage(value: unknown): CodexSubscriptionUsage["usage"] {
  const body = isRecord(value) ? value : {};
  const summaryBody = isRecord(body.summary) ? body.summary : {};
  return {
    summary: {
      lifetimeTokens: asNumberOrNull(summaryBody.lifetimeTokens),
      peakDailyTokens: asNumberOrNull(summaryBody.peakDailyTokens),
      currentStreakDays: asNumberOrNull(summaryBody.currentStreakDays),
      longestStreakDays: asNumberOrNull(summaryBody.longestStreakDays),
      longestRunningTurnSec: asNumberOrNull(summaryBody.longestRunningTurnSec)
    },
    dailyUsageBuckets: Array.isArray(body.dailyUsageBuckets)
      ? body.dailyUsageBuckets.filter(isRecord).map((bucket) => ({ startDate: asString(bucket.startDate), tokens: asNumberOrNull(bucket.tokens) ?? 0 })).filter((bucket) => bucket.startDate)
      : []
  };
}

export class CodexSubscriptionService {
  private readonly rateLimitCacheTtlMs: number;
  private rateLimitCache?: { snapshot: CodexRateLimitSnapshot; expiresAt: number };
  private unsubscribeNotifications?: () => void;

  constructor(
    private readonly client: AccountClient,
    private readonly ensureInitialized: () => Promise<void>,
    options: { rateLimitCacheTtlMs?: number } = {}
  ) {
    this.rateLimitCacheTtlMs = Math.max(1_000, options.rateLimitCacheTtlMs ?? 30_000);
    this.unsubscribeNotifications = client.subscribeNotifications?.((notification) => {
      if (notification.method !== "account/rateLimits/updated") return;
      const params = isRecord(notification.params) ? notification.params : {};
      if (params.rateLimits) {
        const rateLimits = isRecord(params.rateLimits) ? params.rateLimits : {};
        this.rateLimitCache = {
          snapshot: mapRateLimit({ ...rateLimits, rateLimitsByLimitId: params.rateLimitsByLimitId }),
          expiresAt: Date.now() + this.rateLimitCacheTtlMs
        };
      }
    });
  }

  async listModels(): Promise<CodexModel[]> {
    await this.ensureInitialized();
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const response: Record<string, unknown> = await this.client.request<Record<string, unknown>>("model/list", { cursor, includeHidden: false, limit: 100 });
      const data = Array.isArray(response?.data) ? response.data : [];
      models.push(...data.map((entry: unknown) => mapModel(entry)).filter((model: CodexModel | null): model is CodexModel => model !== null));
      cursor = typeof response?.nextCursor === "string" && response.nextCursor ? response.nextCursor : null;
    } while (cursor);
    return models;
  }

  async readCapabilities(): Promise<CodexProviderCapabilities> {
    await this.ensureInitialized();
    const response = await this.client.request<Record<string, unknown>>("modelProvider/capabilities/read", {});
    return {
      imageGeneration: asBoolean(response?.imageGeneration),
      namespaceTools: asBoolean(response?.namespaceTools),
      webSearch: asBoolean(response?.webSearch)
    };
  }

  async readCatalog(): Promise<CodexModelCatalog> {
    const [models, capabilities] = await Promise.all([this.listModels(), this.readCapabilities()]);
    return { models, capabilities };
  }

  async readRateLimits(force = false): Promise<CodexRateLimitSnapshot> {
    await this.ensureInitialized();
    if (!force && this.rateLimitCache && this.rateLimitCache.expiresAt > Date.now()) return this.rateLimitCache.snapshot;
    const limits = await this.client.request<Record<string, unknown>>("account/rateLimits/read", undefined);
    const snapshot = mapRateLimit(limits?.rateLimits ? { ...limits.rateLimits, rateLimitsByLimitId: limits.rateLimitsByLimitId } : limits);
    this.rateLimitCache = { snapshot, expiresAt: Date.now() + this.rateLimitCacheTtlMs };
    return snapshot;
  }

  async readUsage(force = false): Promise<CodexSubscriptionUsage> {
    await this.ensureInitialized();
    const [rateLimits, usage] = await Promise.all([
      this.readRateLimits(force),
      this.client.request<Record<string, unknown>>("account/usage/read", {})
    ]);
    return {
      rateLimits,
      usage: mapUsage(usage)
    };
  }

  async close(): Promise<void> {
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = undefined;
  }

  async validateSelection(model: string, effort?: string): Promise<CodexModel> {
    const catalog = await this.listModels();
    const selected = catalog.find((candidate) => candidate.id === model || candidate.model === model);
    if (!selected) throw new Error(`OpenAI model is not available in the live Codex catalog: ${model}`);
    if (effort && !selected.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === effort)) {
      throw new Error(`Reasoning effort ${effort} is not supported by model ${selected.id}`);
    }
    return selected;
  }
}
