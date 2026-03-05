import type { SearchResult } from "../../../types.js";
import type { SearchProvider } from "../types.js";

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveApiResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export class BraveProvider implements SearchProvider {
  readonly name = "brave" as const;

  constructor(private readonly apiKey: string) {}

  async healthcheck(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error("Brave API key is not configured");
    }

    const searchUrl = new URL("https://api.search.brave.com/res/v1/web/search");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("count", String(maxResults));

    const response = await fetch(searchUrl, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`Brave search failed with status ${response.status}`);
    }

    const payload = (await response.json()) as BraveApiResponse;
    const results = payload.web?.results ?? [];

    const normalized: SearchResult[] = [];
    for (const [index, item] of results.entries()) {
      const url = item.url?.trim();
      if (!url) {
        continue;
      }
      normalized.push({
        title: item.title?.trim() || url,
        url,
        snippet: item.description?.trim() || "",
        provider: this.name,
        rank: index + 1
      });
    }

    return normalized.slice(0, maxResults);
  }
}
