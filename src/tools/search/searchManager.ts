import { spawn } from "node:child_process";
import type { SearchProviderName } from "../../types.js";
import type { SearchProvider, SearchResponse } from "./types.js";

interface SearchManagerOptions {
  primary: SearchProvider;
  fallback?: SearchProvider;
  primaryStartCommand?: string;
  maxResults: number;
  startupTimeoutMs: number;
  retryIntervalMs: number;
}

interface ProviderStatus {
  primaryHealthy: boolean;
  fallbackHealthy: boolean;
  activeDefault: SearchProviderName;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class SearchManager {
  private readonly primary: SearchProvider;
  private readonly fallback?: SearchProvider;
  private readonly primaryStartCommand?: string;
  private readonly maxResults: number;
  private readonly startupTimeoutMs: number;
  private readonly retryIntervalMs: number;

  constructor(options: SearchManagerOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.primaryStartCommand = options.primaryStartCommand;
    this.maxResults = options.maxResults;
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.retryIntervalMs = options.retryIntervalMs;
  }

  private async ensurePrimaryHealthy(): Promise<boolean> {
    if (await this.primary.healthcheck()) {
      return true;
    }

    if (!this.primaryStartCommand) {
      return false;
    }

    spawn(this.primaryStartCommand, {
      stdio: "ignore",
      detached: true,
      shell: true
    }).unref();

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.retryIntervalMs);
      if (await this.primary.healthcheck()) {
        return true;
      }
    }
    return false;
  }

  async getProviderStatus(): Promise<ProviderStatus> {
    const [primaryHealthy, fallbackHealthy] = await Promise.all([
      this.primary.healthcheck(),
      this.fallback ? this.fallback.healthcheck() : Promise.resolve(false)
    ]);

    return {
      primaryHealthy,
      fallbackHealthy,
      activeDefault: primaryHealthy ? this.primary.name : this.fallback?.name ?? this.primary.name
    };
  }

  async search(query: string, requestedMaxResults?: number): Promise<SearchResponse> {
    const cappedMax = Math.min(this.maxResults, requestedMaxResults ?? this.maxResults);

    const primaryHealthy = await this.ensurePrimaryHealthy();
    if (primaryHealthy) {
      const primaryResults = await this.primary.search(query, cappedMax);
      if (primaryResults.length > 0) {
        return {
          provider: this.primary.name,
          fallbackUsed: false,
          results: primaryResults
        };
      }
    }

    if (!this.fallback) {
      throw new Error("Primary search unavailable and no fallback configured");
    }

    const fallbackResults = await this.fallback.search(query, cappedMax);
    return {
      provider: this.fallback.name,
      fallbackUsed: true,
      results: fallbackResults
    };
  }
}
