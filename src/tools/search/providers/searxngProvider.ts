import type { SearchResult } from "../../../types.js";
import type { SearchProvider } from "../types.js";

interface SearxResultItem {
  title?: string;
  url?: string;
  content?: string;
}

interface SearxApiResponse {
  results?: SearxResultItem[];
}

export class SearxngProvider implements SearchProvider {
  readonly name = "searxng" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly searchPath: string,
    private readonly healthPath: string
  ) {}

  async healthcheck(): Promise<boolean> {
    const url = new URL(this.healthPath, this.baseUrl);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const searchUrl = new URL(this.searchPath, this.baseUrl);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");

    const response = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      throw new Error(`SearXNG search failed with status ${response.status}`);
    }

    const payload = (await response.json()) as SearxApiResponse;
    const results = payload.results ?? [];

    const normalized: SearchResult[] = [];
    for (const [index, item] of results.entries()) {
      const url = item.url?.trim();
      if (!url) {
        continue;
      }
      normalized.push({
        title: item.title?.trim() || url,
        url,
        snippet: item.content?.trim() || "",
        provider: this.name,
        rank: index + 1
      });
    }

    return normalized.slice(0, maxResults);
  }
}
