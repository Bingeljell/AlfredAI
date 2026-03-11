export type FailureClass = "network" | "timeout" | "schema" | "policy_block" | "unknown";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

const TIMEOUT_MARKERS = ["timeout", "timed out", "aborted", "aborterror", "etimedout"];

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableHttpStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

export function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const delta = parsedDate - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

export function computeRetryDelayMs(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  const safeAttempt = Math.max(1, attempt);
  const expDelay = Math.min(policy.maxDelayMs, Math.round(policy.baseDelayMs * 2 ** (safeAttempt - 1)));
  const jitter = Math.round(expDelay * policy.jitterRatio * Math.random());
  const candidate = expDelay + jitter;
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(policy.maxDelayMs, Math.max(candidate, retryAfterMs));
  }
  return candidate;
}

export function isLikelyTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const marker = `${error.name} ${error.message}`.toLowerCase();
  return (
    marker.includes("fetch failed") ||
    marker.includes("network") ||
    marker.includes("socket") ||
    marker.includes("econn") ||
    marker.includes("enotfound") ||
    TIMEOUT_MARKERS.some((item) => marker.includes(item))
  );
}

export function classifyStructuredFailure(args: {
  failureCode?: string;
  statusCode?: number;
  failureMessage?: string;
}): FailureClass {
  const message = args.failureMessage?.toLowerCase() ?? "";

  if (args.failureCode === "json_parse_error" || args.failureCode === "zod_validation_error") {
    return "schema";
  }

  if (args.failureCode === "http_error") {
    const status = args.statusCode ?? 0;
    if (status === 401 || status === 403) {
      return "policy_block";
    }
    if (status === 408 || status === 429) {
      return "timeout";
    }
    if (status >= 500 || status === 409 || status === 425) {
      return "network";
    }
  }

  if (args.failureCode === "network_error") {
    if (TIMEOUT_MARKERS.some((item) => message.includes(item))) {
      return "timeout";
    }
    return "network";
  }

  if (TIMEOUT_MARKERS.some((item) => message.includes(item))) {
    return "timeout";
  }

  return "unknown";
}
