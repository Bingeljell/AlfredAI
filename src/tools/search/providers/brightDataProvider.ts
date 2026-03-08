import type { SearchResult } from "../../../types.js";
import type { SearchProvider } from "../types.js";

interface BrightDataProviderOptions {
  apiKey: string;
  baseUrl: string;
  searchPath: string;
  engine: string;
  timeoutMs: number;
}

interface GenericSearchItem {
  [key: string]: unknown;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickFirstString(item: GenericSearchItem, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(item[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractCandidateItems(payload: unknown): GenericSearchItem[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const directKeys = ["results", "organic", "organic_results", "items", "data"];
  for (const key of directKeys) {
    const items = asArray(root[key])
      .map((entry) => asRecord(entry))
      .filter((entry): entry is GenericSearchItem => Boolean(entry));
    if (items.length > 0) {
      return items;
    }
  }

  const nestedKeys = ["response", "search", "serp"];
  for (const key of nestedKeys) {
    const nested = asRecord(root[key]);
    if (!nested) {
      continue;
    }
    for (const nestedListKey of directKeys) {
      const items = asArray(nested[nestedListKey])
        .map((entry) => asRecord(entry))
        .filter((entry): entry is GenericSearchItem => Boolean(entry));
      if (items.length > 0) {
        return items;
      }
    }
  }

  return [];
}

function normalizeResults(payload: unknown, maxResults: number): SearchResult[] {
  const items = extractCandidateItems(payload);
  const normalized: SearchResult[] = [];

  for (const item of items) {
    const url = pickFirstString(item, ["url", "link", "target_url", "href"]);
    if (!url) {
      continue;
    }
    normalized.push({
      title: pickFirstString(item, ["title", "name", "headline"]) ?? url,
      url,
      snippet: pickFirstString(item, ["description", "snippet", "content", "text"]) ?? "",
      provider: "brightdata",
      rank: normalized.length + 1
    });
    if (normalized.length >= maxResults) {
      break;
    }
  }

  return normalized;
}

export class BrightDataProvider implements SearchProvider {
  readonly name = "brightdata" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly searchPath: string;
  private readonly engine: string;
  private readonly timeoutMs: number;

  constructor(options: BrightDataProviderOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = options.baseUrl;
    this.searchPath = options.searchPath;
    this.engine = options.engine.trim();
    this.timeoutMs = options.timeoutMs;
  }

  async healthcheck(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("Bright Data API key is not configured");
    }

    const searchUrl = new URL(this.searchPath, this.baseUrl);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("num_results", String(maxResults));
    if (this.engine) {
      searchUrl.searchParams.set("engine", this.engine);
    }

    const response = await fetch(searchUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      const bodySnippet = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
      throw new Error(
        `Bright Data search failed with status ${response.status}${bodySnippet ? `: ${bodySnippet}` : ""}`
      );
    }

    const payload = (await response.json()) as unknown;
    return normalizeResults(payload, maxResults);
  }
}

