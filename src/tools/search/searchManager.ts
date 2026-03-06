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
  primaryHealthRetries?: number;
  primaryHealthRetryDelayMs?: number;
  primaryHealthGraceMs?: number;
}

export interface ProviderStatus {
  primaryProvider: SearchProviderName;
  fallbackProvider?: SearchProviderName;
  primaryHealthy: boolean;
  fallbackHealthy: boolean;
  primaryRecoverySupported: boolean;
  activeDefault: SearchProviderName;
  lastPrimaryHealthyAt?: string;
  consecutivePrimaryFailures: number;
  lastPrimaryFailure?: SearchFailureDiagnostic;
  lastPrimaryRecovery?: PrimaryRecoveryResult;
}

export interface SearchFailureDiagnostic {
  stage: "healthcheck" | "primary_search" | "primary_retry" | "fallback_search";
  provider: SearchProviderName;
  reason: string;
  timestamp: string;
  query?: string;
  httpStatus?: number;
  transient?: boolean;
}

export class SearchManagerError extends Error {
  constructor(
    message: string,
    readonly diagnostic: SearchFailureDiagnostic
  ) {
    super(message);
    this.name = "SearchManagerError";
  }
}

export interface PrimaryRecoveryResult {
  attempted: boolean;
  recovered: boolean;
  reason: string;
  command?: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  stdoutSnippet?: string;
  stderrSnippet?: string;
  spawnError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clipSnippet(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function appendSnippet(current: string, chunk: unknown, max = 512): string {
  const text =
    typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  const merged = `${current}${text}`;
  if (merged.length <= max) {
    return merged;
  }
  return merged.slice(merged.length - max);
}

export class SearchManager {
  private readonly primary: SearchProvider;
  private readonly fallback?: SearchProvider;
  private readonly primaryStartCommand?: string;
  private readonly maxResults: number;
  private readonly startupTimeoutMs: number;
  private readonly retryIntervalMs: number;
  private readonly primaryHealthRetries: number;
  private readonly primaryHealthRetryDelayMs: number;
  private readonly primaryHealthGraceMs: number;
  private lastPrimaryHealthyAtMs?: number;
  private lastPrimaryFailure?: SearchFailureDiagnostic;
  private lastPrimaryRecovery?: PrimaryRecoveryResult;
  private consecutivePrimaryFailures = 0;

  constructor(options: SearchManagerOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.primaryStartCommand = options.primaryStartCommand;
    this.maxResults = options.maxResults;
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.retryIntervalMs = options.retryIntervalMs;
    this.primaryHealthRetries = Math.max(0, Math.round(options.primaryHealthRetries ?? 2));
    this.primaryHealthRetryDelayMs = Math.max(0, Math.round(options.primaryHealthRetryDelayMs ?? 250));
    this.primaryHealthGraceMs = Math.max(0, Math.round(options.primaryHealthGraceMs ?? 15_000));
  }

  private recordPrimaryHealthy(): void {
    this.lastPrimaryHealthyAtMs = Date.now();
    this.consecutivePrimaryFailures = 0;
  }

  private recordPrimaryFailure(diagnostic: Omit<SearchFailureDiagnostic, "timestamp" | "provider"> & { provider?: SearchProviderName }): void {
    this.consecutivePrimaryFailures += 1;
    this.lastPrimaryFailure = {
      provider: diagnostic.provider ?? this.primary.name,
      stage: diagnostic.stage,
      reason: diagnostic.reason,
      query: diagnostic.query,
      httpStatus: diagnostic.httpStatus,
      transient: diagnostic.transient,
      timestamp: new Date().toISOString()
    };
  }

  private isPrimaryGraceHealthy(): boolean {
    if (!this.lastPrimaryHealthyAtMs || this.primaryHealthGraceMs <= 0) {
      return false;
    }
    return Date.now() - this.lastPrimaryHealthyAtMs <= this.primaryHealthGraceMs;
  }

  private async checkPrimaryHealthWithRetry(): Promise<boolean> {
    const attempts = this.primaryHealthRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.primary.healthcheck()) {
        return true;
      }
      if (attempt < attempts - 1 && this.primaryHealthRetryDelayMs > 0) {
        await sleep(this.primaryHealthRetryDelayMs);
      }
    }
    return false;
  }

  private async ensurePrimaryHealthy(): Promise<boolean> {
    if (await this.checkPrimaryHealthWithRetry()) {
      this.recordPrimaryHealthy();
      return true;
    }

    this.recordPrimaryFailure({
      stage: "healthcheck",
      reason: "primary_healthcheck_failed_after_retries",
      transient: true
    });

    if (this.isPrimaryGraceHealthy()) {
      return true;
    }

    const recovery = await this.recoverPrimary();
    if (recovery.recovered) {
      this.recordPrimaryHealthy();
      return true;
    }
    return false;
  }

  async recoverPrimary(): Promise<PrimaryRecoveryResult> {
    const startedAt = new Date().toISOString();
    const command = this.primaryStartCommand?.trim();
    const complete = (result: PrimaryRecoveryResult): PrimaryRecoveryResult => {
      const finalized: PrimaryRecoveryResult = {
        ...result,
        startedAt: result.startedAt ?? startedAt,
        completedAt: result.completedAt ?? new Date().toISOString()
      };
      this.lastPrimaryRecovery = finalized;
      return finalized;
    };

    if (!command) {
      return complete({
        attempted: false,
        recovered: false,
        reason: "primary_start_command_not_configured"
      });
    }

    let stdoutSnippet = "";
    let stderrSnippet = "";
    let processExited = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let spawnError: string | undefined;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        shell: true
      });
    } catch (error) {
      return complete({
        attempted: true,
        recovered: false,
        reason: "primary_start_command_spawn_failed",
        command: clipSnippet(command, 280),
        spawnError: clipSnippet(error instanceof Error ? error.message : String(error))
      });
    }

    child.stdout?.on("data", (chunk) => {
      stdoutSnippet = appendSnippet(stdoutSnippet, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrSnippet = appendSnippet(stderrSnippet, chunk);
    });
    child.once("error", (error) => {
      spawnError = clipSnippet(error instanceof Error ? error.message : String(error));
    });
    child.once("exit", (code, signal) => {
      processExited = true;
      exitCode = typeof code === "number" ? code : null;
      exitSignal = typeof signal === "string" ? signal : null;
    });

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.retryIntervalMs);
      if (await this.primary.healthcheck()) {
        child.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        return complete({
          attempted: true,
          recovered: true,
          reason: "primary_recovered_after_restart",
          command: clipSnippet(command, 280),
          stdoutSnippet: stdoutSnippet ? clipSnippet(stdoutSnippet, 280) : undefined,
          stderrSnippet: stderrSnippet ? clipSnippet(stderrSnippet, 280) : undefined
        });
      }
      if (spawnError) {
        return complete({
          attempted: true,
          recovered: false,
          reason: "primary_start_command_runtime_error",
          command: clipSnippet(command, 280),
          spawnError,
          stdoutSnippet: stdoutSnippet ? clipSnippet(stdoutSnippet, 280) : undefined,
          stderrSnippet: stderrSnippet ? clipSnippet(stderrSnippet, 280) : undefined
        });
      }
      if (processExited) {
        return complete({
          attempted: true,
          recovered: false,
          reason: "primary_start_command_exited",
          command: clipSnippet(command, 280),
          exitCode,
          signal: exitSignal,
          stdoutSnippet: stdoutSnippet ? clipSnippet(stdoutSnippet, 280) : undefined,
          stderrSnippet: stderrSnippet ? clipSnippet(stderrSnippet, 280) : undefined
        });
      }
    }
    child.unref();
    child.stdout?.destroy();
    child.stderr?.destroy();
    return complete({
      attempted: true,
      recovered: false,
      reason: "primary_unhealthy_after_restart_timeout",
      command: clipSnippet(command, 280),
      exitCode,
      signal: exitSignal,
      spawnError,
      stdoutSnippet: stdoutSnippet ? clipSnippet(stdoutSnippet, 280) : undefined,
      stderrSnippet: stderrSnippet ? clipSnippet(stderrSnippet, 280) : undefined
    });
  }

  async getProviderStatus(): Promise<ProviderStatus> {
    const [primaryHealthy, fallbackHealthy] = await Promise.all([
      this.checkPrimaryHealthWithRetry(),
      this.fallback ? this.fallback.healthcheck() : Promise.resolve(false)
    ]);

    if (primaryHealthy) {
      this.recordPrimaryHealthy();
    }

    return {
      primaryProvider: this.primary.name,
      fallbackProvider: this.fallback?.name,
      primaryHealthy,
      fallbackHealthy,
      primaryRecoverySupported: Boolean(this.primaryStartCommand),
      activeDefault: primaryHealthy ? this.primary.name : this.fallback?.name ?? this.primary.name,
      lastPrimaryHealthyAt: this.lastPrimaryHealthyAtMs ? new Date(this.lastPrimaryHealthyAtMs).toISOString() : undefined,
      consecutivePrimaryFailures: this.consecutivePrimaryFailures,
      lastPrimaryFailure: this.lastPrimaryFailure,
      lastPrimaryRecovery: this.lastPrimaryRecovery
    };
  }

  async search(query: string, requestedMaxResults?: number): Promise<SearchResponse> {
    const cappedMax = Math.min(this.maxResults, requestedMaxResults ?? this.maxResults);

    const primaryHealthy = await this.ensurePrimaryHealthy();
    if (primaryHealthy) {
      try {
        const primaryResults = await this.primary.search(query, cappedMax);
        if (primaryResults.length > 0) {
          this.recordPrimaryHealthy();
          return {
            provider: this.primary.name,
            fallbackUsed: false,
            results: primaryResults
          };
        }
      } catch (error) {
        const primarySearchError = error instanceof Error ? error.message : "primary_search_failed";
        this.recordPrimaryFailure({
          stage: "primary_search",
          reason: primarySearchError,
          query,
          transient: true
        });
        const recovery = await this.recoverPrimary();
        if (recovery.recovered) {
          try {
            const retriedResults = await this.primary.search(query, cappedMax);
            if (retriedResults.length > 0) {
              this.recordPrimaryHealthy();
              return {
                provider: this.primary.name,
                fallbackUsed: false,
                results: retriedResults
              };
            }
          } catch {
            this.recordPrimaryFailure({
              stage: "primary_retry",
              reason: "primary_retry_failed_after_recovery",
              query,
              transient: true
            });
            // Ignore and fall through to fallback provider path below.
          }
        }

        if (!this.fallback) {
          throw new SearchManagerError(
            `Primary search failed (${primarySearchError}); ${recovery.reason}; no fallback configured`,
            {
              provider: this.primary.name,
              stage: "primary_search",
              reason: `${primarySearchError}; ${recovery.reason}; no_fallback_configured`,
              query,
              timestamp: new Date().toISOString(),
              transient: true
            }
          );
        }
      }
    }

    if (!this.fallback) {
      const reason = this.lastPrimaryFailure?.reason ?? "primary_unavailable_no_fallback";
      throw new SearchManagerError("Primary search unavailable and no fallback configured", {
        provider: this.primary.name,
        stage: "healthcheck",
        reason,
        query,
        timestamp: new Date().toISOString(),
        transient: true
      });
    }

    try {
      const fallbackResults = await this.fallback.search(query, cappedMax);
      return {
        provider: this.fallback.name,
        fallbackUsed: true,
        results: fallbackResults
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "fallback_search_failed";
      throw new SearchManagerError(`Fallback search failed (${reason})`, {
        provider: this.fallback.name,
        stage: "fallback_search",
        reason,
        query,
        timestamp: new Date().toISOString(),
        transient: true
      });
    }
  }
}
