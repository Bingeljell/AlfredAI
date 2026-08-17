import { randomUUID } from "node:crypto";
import { getCodexCredentials, CODEX_LOGIN_EXPIRED, CODEX_LOGIN_INVALID } from "./auth.js";
import { buildCodexRequestBody } from "./messages.js";
import type { CodexTransportRequest, CodexTransportResult } from "./types.js";

export const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const USER_AGENT = "AlfredAI/0.1.0";

export interface CodexTransportOptions {
  authFilePath?: string;
  fetchImpl?: typeof fetch;
}

function isTerminalUsageLimit(text: string): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|monthly usage limit|usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(text);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /fetch failed|network|socket|econn|enotfound|timed out|timeout|aborted/i.test(`${error.name} ${error.message}`);
}

function retryAfterMs(headers: Headers): number | undefined {
  const retryAfterMsHeader = headers.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const value = Number(retryAfterMsHeader);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isTimeoutReason(reason: unknown): boolean {
  return reason === "deadline" || reason === "timeout" || reason === "deadline_abort"
    || (reason instanceof Error && /deadline|timed out|timeout/i.test(reason.message));
}

function abortFailure(signal: AbortSignal, elapsedMs: number, attempts: number, timeoutMs?: number): CodexTransportResult {
  const deadline = isTimeoutReason(signal.reason);
  return {
    ok: false,
    failureCode: "cancelled",
    failureClass: deadline ? "timeout" : "unknown",
    failureMessage: deadline ? "Codex request timed out." : "Codex request was cancelled.",
    attempts,
    elapsedMs,
    softTimeoutMs: timeoutMs,
    hardTimeoutMs: timeoutMs,
    softTimeoutExceeded: deadline
  };
}

function authFailure(error: unknown, elapsedMs: number, attempts: number, timeoutMs?: number): CodexTransportResult {
  const message = error instanceof Error ? error.message : "";
  if (message === CODEX_LOGIN_EXPIRED || /invalid_grant|login expired/i.test(message)) {
    return {
      ok: false,
      failureCode: "codex_login_expired",
      failureClass: "policy_block",
      failureMessage: CODEX_LOGIN_EXPIRED,
      attempts,
      elapsedMs,
      softTimeoutMs: timeoutMs,
      hardTimeoutMs: timeoutMs
    };
  }
  return {
    ok: false,
    failureCode: "codex_login_invalid",
    failureClass: "policy_block",
    failureMessage: message === CODEX_LOGIN_INVALID ? CODEX_LOGIN_INVALID : CODEX_LOGIN_INVALID,
    attempts,
    elapsedMs,
    softTimeoutMs: timeoutMs,
    hardTimeoutMs: timeoutMs
  };
}

export class CodexTransport {
  readonly endpoint = CODEX_RESPONSES_ENDPOINT;
  private readonly authFilePath?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CodexTransportOptions = {}) {
    this.authFilePath = options.authFilePath;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(request: CodexTransportRequest): Promise<CodexTransportResult> {
    const startedAt = Date.now();
    const timeoutMs = typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs)
      ? Math.max(1_000, Math.round(request.timeoutMs))
      : 90_000;
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal?.reason ?? "caller_cancellation");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const deadlineAt = startedAt + timeoutMs;
    let retainedForStream = false;
    const cleanup = () => {
      if (retainedForStream) retainedForStream = false;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    };
    const ensureBudget = (): boolean => {
      if (controller.signal.aborted) return false;
      if (Date.now() >= deadlineAt) {
        controller.abort("timeout");
        return false;
      }
      return true;
    };
    let credentials;
    try {
      credentials = await getCodexCredentials({ authFilePath: this.authFilePath, fetchImpl: this.fetchImpl, signal: controller.signal });
    } catch (error) {
      const result = controller.signal.aborted || !ensureBudget()
        ? abortFailure(controller.signal, Date.now() - startedAt, 0, timeoutMs)
        : authFailure(error, Date.now() - startedAt, 0, timeoutMs);
      cleanup();
      return result;
    }

    let authRetried = false;
    let attempts = 0;
    const maxAttempts = Math.max(1, Math.min(6, Math.round(request.maxAttempts ?? 3)));

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (!ensureBudget()) return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
        attempts += 1;
        const requestId = randomUUID();
        const body = buildCodexRequestBody({
          model: request.model,
          messages: request.messages,
          tools: request.tools,
          sessionId: request.sessionId,
          text: request.text
        });
        let response: Response;
        try {
          response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${credentials.accessToken}`,
              "chatgpt-account-id": credentials.accountId,
              originator: "alfred",
              "User-Agent": USER_AGENT,
              "OpenAI-Beta": "responses=experimental",
              Accept: "text/event-stream",
              "Content-Type": "application/json",
              "session-id": requestId,
              "x-client-request-id": requestId
            },
            body: JSON.stringify(body),
            signal: controller.signal
          });
        } catch (error) {
          if (controller.signal.aborted) return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
          if (!ensureBudget()) return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
          if (attempt < maxAttempts && isTransientError(error)) {
            const remainingBudget = Math.max(0, deadlineAt - Date.now());
            const backoff = Math.min(2_500, 300 * 2 ** (attempt - 1));
            const delay = Math.min(60_000, remainingBudget, backoff);
            if (delay <= 0) {
              controller.abort("timeout");
              return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
            }
            try {
              await sleep(delay, controller.signal);
            } catch {
              return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
            }
            continue;
          }
          return {
            ok: false,
            failureCode: "network_error",
            failureClass: "network",
            failureMessage: "Codex network request failed.",
            attempts,
            elapsedMs: Date.now() - startedAt,
            softTimeoutMs: timeoutMs,
            hardTimeoutMs: timeoutMs,
            softTimeoutExceeded: Date.now() - startedAt > timeoutMs
          };
        }

        if (response.ok) {
          if (!ensureBudget()) return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
          retainedForStream = true;
          return {
            ok: true,
            response,
            signal: controller.signal,
            cleanup,
            statusCode: response.status,
            attempts,
            elapsedMs: Date.now() - startedAt,
            softTimeoutMs: timeoutMs,
            hardTimeoutMs: timeoutMs,
            softTimeoutExceeded: Date.now() - startedAt > timeoutMs
          };
        }

        if (response.status === 401 && !authRetried) {
          authRetried = true;
          await response.arrayBuffer().catch(() => undefined);
          try {
            credentials = await getCodexCredentials({
              authFilePath: this.authFilePath,
              fetchImpl: this.fetchImpl,
              signal: controller.signal,
              forceRefresh: true
            });
          } catch {
            if (controller.signal.aborted || !ensureBudget()) return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
            return {
              ok: false,
              failureCode: "codex_login_expired",
              failureClass: "policy_block",
              failureMessage: CODEX_LOGIN_EXPIRED,
              statusCode: 401,
              attempts,
              elapsedMs: Date.now() - startedAt,
              softTimeoutMs: timeoutMs,
              hardTimeoutMs: timeoutMs
            };
          }
          attempt -= 1;
          continue;
        }

        if (response.status === 401) {
          await response.arrayBuffer().catch(() => undefined);
          if (controller.signal.aborted) return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
          return {
            ok: false,
            failureCode: "codex_login_expired",
            failureClass: "policy_block",
            failureMessage: CODEX_LOGIN_EXPIRED,
            statusCode: 401,
            attempts,
            elapsedMs: Date.now() - startedAt,
            softTimeoutMs: timeoutMs,
            hardTimeoutMs: timeoutMs
          };
        }

        let errorBody = "";
        try { errorBody = await response.text(); } catch { /* diagnostics never need the body */ }
        if (controller.signal.aborted) return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
        if (attempt < maxAttempts && isRetryableStatus(response.status) && !(response.status === 429 && isTerminalUsageLimit(errorBody))) {
          const serverDelay = retryAfterMs(response.headers);
          const backoff = Math.min(2_500, 300 * 2 ** (attempt - 1));
          const remainingBudget = Math.max(0, deadlineAt - Date.now());
          const delay = Math.min(60_000, remainingBudget, Math.max(backoff, serverDelay ?? 0));
          if (delay <= 0) {
            controller.abort("timeout");
            return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
          }
          try {
            await sleep(delay, controller.signal);
          } catch {
            return abortFailure(controller.signal, Date.now() - startedAt, attempts, timeoutMs);
          }
          continue;
        }

        const failureCode = response.status === 429 ? "rate_limit" : "http_error";
        const failureClass = response.status === 401 || response.status === 403 ? "policy_block" : response.status >= 500 ? "network" : "unknown";
        return {
          ok: false,
          failureCode,
          failureClass,
          failureMessage: response.status === 429 ? "Codex subscription rate limit reached." : `Codex request failed (HTTP ${response.status}).`,
          statusCode: response.status,
          attempts,
          elapsedMs: Date.now() - startedAt,
          softTimeoutMs: timeoutMs,
          hardTimeoutMs: timeoutMs,
          softTimeoutExceeded: Date.now() - startedAt > timeoutMs
        };
      }
    } finally {
      if (!retainedForStream) cleanup();
    }

    return {
      ok: false,
      failureCode: "network_error",
      failureClass: "network",
      failureMessage: "Codex request failed after retries.",
      attempts,
      elapsedMs: Date.now() - startedAt,
      softTimeoutMs: timeoutMs,
      hardTimeoutMs: timeoutMs
    };
  }
}

export async function requestCodexResponse(request: CodexTransportRequest, options: CodexTransportOptions = {}): Promise<CodexTransportResult> {
  return new CodexTransport(options).request(request);
}
