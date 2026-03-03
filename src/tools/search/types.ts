import type { SearchProviderName, SearchResult } from "../../types.js";

export interface SearchProvider {
  readonly name: SearchProviderName;
  healthcheck(): Promise<boolean>;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

export interface SearchResponse {
  provider: SearchProviderName;
  fallbackUsed: boolean;
  results: SearchResult[];
}
