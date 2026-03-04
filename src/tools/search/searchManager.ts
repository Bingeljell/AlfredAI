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

export interface ProviderStatus {
  primaryProvider: SearchProviderName;
  fallbackProvider?: SearchProviderName;
  primaryHealthy: boolean;
  fallbackHealthy: boolean;
  primaryRecoverySupported: boolean;
  activeDefault: SearchProviderName;
}

export interface PrimaryRecoveryResult {
  attempted: boolean;
  recovered: boolean;
  reason: string;
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

    const recovery = await this.recoverPrimary();
    return recovery.recovered;
  }

  async recoverPrimary(): Promise<PrimaryRecoveryResult> {
    if (!this.primaryStartCommand) {
      return {
        attempted: false,
        recovered: false,
        reason: "primary_start_command_not_configured"
      };
    }

    try {
      spawn(this.primaryStartCommand, {
        stdio: "ignore",
        detached: true,
        shell: true
      }).unref();
    } catch {
      return {
        attempted: true,
        recovered: false,
        reason: "primary_start_command_spawn_failed"
      };
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.retryIntervalMs);
      if (await this.primary.healthcheck()) {
        return {
          attempted: true,
          recovered: true,
          reason: "primary_recovered_after_restart"
        };
      }
    }
    return {
      attempted: true,
      recovered: false,
      reason: "primary_unhealthy_after_restart_timeout"
    };
  }

  async getProviderStatus(): Promise<ProviderStatus> {
    const [primaryHealthy, fallbackHealthy] = await Promise.all([
      this.primary.healthcheck(),
      this.fallback ? this.fallback.healthcheck() : Promise.resolve(false)
    ]);

    return {
      primaryProvider: this.primary.name,
      fallbackProvider: this.fallback?.name,
      primaryHealthy,
      fallbackHealthy,
      primaryRecoverySupported: Boolean(this.primaryStartCommand),
      activeDefault: primaryHealthy ? this.primary.name : this.fallback?.name ?? this.primary.name
    };
  }

  async search(query: string, requestedMaxResults?: number): Promise<SearchResponse> {
    const cappedMax = Math.min(this.maxResults, requestedMaxResults ?? this.maxResults);

    const primaryHealthy = await this.ensurePrimaryHealthy();
    if (primaryHealthy) {
      try {
        const primaryResults = await this.primary.search(query, cappedMax);
        if (primaryResults.length > 0) {
          return {
            provider: this.primary.name,
            fallbackUsed: false,
            results: primaryResults
          };
        }
      } catch (error) {
        const primarySearchError = error instanceof Error ? error.message : "primary_search_failed";
        const recovery = await this.recoverPrimary();
        if (recovery.recovered) {
          try {
            const retriedResults = await this.primary.search(query, cappedMax);
            if (retriedResults.length > 0) {
              return {
                provider: this.primary.name,
                fallbackUsed: false,
                results: retriedResults
              };
            }
          } catch {
            // Ignore and fall through to fallback provider path below.
          }
        }

        if (!this.fallback) {
          throw new Error(`Primary search failed (${primarySearchError}); ${recovery.reason}; no fallback configured`);
        }
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
