import { z } from "zod";
import type { LlmUsage } from "../types.js";
import {
  classifyStructuredFailure,
  computeRetryDelayMs,
  isLikelyTransientNetworkError,
  isRetryableHttpStatus,
  parseRetryAfterMs,
  sleep,
  type FailureClass,
  type RetryPolicy
} from "../core/reliability.js";

interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiChatOptions {
  apiKey?: string;
  model?: string;
  messages: OpenAiMessage[];
  timeoutMs?: number;
  maxAttempts?: number;
  baseUrl?: string;
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

interface OpenAiStructuredChatOptions extends OpenAiChatOptions {
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  // baseUrl inherited from OpenAiChatOptions
}

export type ChatFailureCode =
  | "missing_api_key"
  | "network_error"
  | "http_error"
  | "empty_content";

export type StructuredChatFailureCode =
  | "missing_api_key"
  | "network_error"
  | "http_error"
  | "empty_content"
  | "json_parse_error"
  | "zod_validation_error";

export interface OpenAiChatDiagnostic {
  content?: string;
  failureCode?: ChatFailureCode;
  failureClass?: FailureClass;
  failureMessage?: string;
  statusCode?: number;
  usage?: LlmUsage;
  attempts?: number;
  elapsedMs?: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  softTimeoutExceeded?: boolean;
}

export interface StructuredChatDiagnostic<T> {
  result?: T;
  failureCode?: StructuredChatFailureCode;
  failureClass?: FailureClass;
  failureMessage?: string;
  statusCode?: number;
  httpErrorDetails?: StructuredChatHttpErrorDetails;
  usage?: LlmUsage;
  attempts?: number;
  elapsedMs?: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  softTimeoutExceeded?: boolean;
}

export interface StructuredChatHttpErrorDetails {
  statusCode: number;
  requestId?: string;
  retryAfter?: string;
  rateLimitRemainingRequests?: string;
  rateLimitRemainingTokens?: string;
  errorType?: string;
  errorCode?: string;
  errorParam?: string;
  errorMessage?: string;
  bodySnippet?: string;
}

interface OpenAiHttpErrorPayload {
  error?: {
    message?: unknown;
    type?: unknown;
    param?: unknown;
    code?: unknown;
  };
}

function optionalString(value: unknown, maxLength = 220): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, maxLength);
}

async function buildHttpErrorDetails(response: Response): Promise<StructuredChatHttpErrorDetails> {
  const details: StructuredChatHttpErrorDetails = {
    statusCode: response.status,
    requestId: optionalString(response.headers.get("x-request-id") ?? response.headers.get("request-id"), 120),
    retryAfter: optionalString(response.headers.get("retry-after"), 32),
    rateLimitRemainingRequests: optionalString(response.headers.get("x-ratelimit-remaining-requests"), 32),
    rateLimitRemainingTokens: optionalString(response.headers.get("x-ratelimit-remaining-tokens"), 32)
  };

  let responseText = "";
  try {
    responseText = (await response.text()).trim();
  } catch {
    return details;
  }

  if (!responseText) {
    return details;
  }

  try {
    const payload = JSON.parse(responseText) as OpenAiHttpErrorPayload;
    details.errorType = optionalString(payload.error?.type, 120);
    details.errorCode = optionalString(payload.error?.code, 120);
    details.errorParam = optionalString(payload.error?.param, 120);
    details.errorMessage = optionalString(payload.error?.message, 220);
    if (!details.errorMessage && !details.errorType && !details.errorCode) {
      details.bodySnippet = optionalString(responseText, 220);
    }
  } catch {
    details.bodySnippet = optionalString(responseText, 220);
  }

  return details;
}

function formatHttpFailureMessage(details: StructuredChatHttpErrorDetails): string {
  const fragments = [`OpenAI returned status ${details.statusCode}`];

  const parts: string[] = [];
  if (details.errorType) {
    parts.push(`type=${details.errorType}`);
  }
  if (details.errorCode) {
    parts.push(`code=${details.errorCode}`);
  }
  if (parts.length > 0) {
    fragments.push(parts.join(", "));
  }
  if (details.errorMessage) {
    fragments.push(details.errorMessage);
  } else if (details.bodySnippet) {
    fragments.push(details.bodySnippet);
  }

  return fragments.join(" | ");
}

interface ParsedOpenAiResponse {
  content?: string;
  usage?: LlmUsage;
}

const OPENAI_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 2500,
  jitterRatio: 0.2
};

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const normalized = Math.round(value);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

function resolveSoftTimeoutMs(requested: number | undefined, fallback: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return fallback;
  }
  return clampInteger(requested, 1_000, 120_000);
}

function resolveHardTimeoutMs(softTimeoutMs: number): number {
  // Treat configured timeout as a soft target. Hard abort remains as a safety cap.
  const candidate = Math.max(softTimeoutMs + 15_000, Math.round(softTimeoutMs * 2.25));
  return clampInteger(candidate, softTimeoutMs + 1_000, 180_000);
}

function resolveRetryPolicy(maxAttemptsOverride: number | undefined): RetryPolicy {
  if (typeof maxAttemptsOverride !== "number" || !Number.isFinite(maxAttemptsOverride)) {
    return OPENAI_RETRY_POLICY;
  }
  return {
    ...OPENAI_RETRY_POLICY,
    maxAttempts: clampInteger(maxAttemptsOverride, 1, 6)
  };
}

function shouldOmitTemperature(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("gpt-5");
}

function toTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

function parseUsage(payload: OpenAiResponse): LlmUsage | undefined {
  const promptTokens = toTokenCount(payload.usage?.prompt_tokens) ?? 0;
  const completionTokens = toTokenCount(payload.usage?.completion_tokens) ?? 0;
  const totalTokens = toTokenCount(payload.usage?.total_tokens) ?? promptTokens + completionTokens;

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens
  };
}

async function parseResponse(response: Response): Promise<ParsedOpenAiResponse | undefined> {
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json()) as OpenAiResponse;
  return {
    content: payload.choices?.[0]?.message?.content?.trim() || undefined,
    usage: parseUsage(payload)
  };
}

export async function runOpenAiChatWithDiagnostics(options: OpenAiChatOptions): Promise<OpenAiChatDiagnostic> {
  if (!options.apiKey) {
    return {
      failureCode: "missing_api_key",
      failureClass: "policy_block",
      failureMessage: "OpenAI API key is not configured",
      attempts: 0
    };
  }
  const retryPolicy = resolveRetryPolicy(options.maxAttempts);
  const softTimeoutMs = resolveSoftTimeoutMs(options.timeoutMs, 25_000);
  const hardTimeoutMs = resolveHardTimeoutMs(softTimeoutMs);
  const callStartedAt = Date.now();
  const model = options.model ?? "gpt-5-mini";
  const body: Record<string, unknown> = {
    model,
    messages: options.messages
  };
  if (!shouldOmitTemperature(model)) {
    body.temperature = 0.2;
  }

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(hardTimeoutMs)
      });
    } catch (error) {
      if (attempt < retryPolicy.maxAttempts && isLikelyTransientNetworkError(error)) {
        const delayMs = computeRetryDelayMs(attempt, retryPolicy);
        await sleep(delayMs);
        continue;
      }
      const elapsedMs = Date.now() - callStartedAt;
      return {
        failureCode: "network_error",
        failureClass: classifyStructuredFailure({
          failureCode: "network_error",
          failureMessage: error instanceof Error ? error.message : "Network request failed"
        }),
        failureMessage: error instanceof Error ? error.message : "Network request failed",
        attempts: attempt,
        elapsedMs,
        softTimeoutMs,
        hardTimeoutMs,
        softTimeoutExceeded: elapsedMs > softTimeoutMs
      };
    }

    if (!response.ok) {
      if (attempt < retryPolicy.maxAttempts && isRetryableHttpStatus(response.status)) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after") ?? undefined);
        const delayMs = computeRetryDelayMs(attempt, retryPolicy, retryAfterMs);
        await response.arrayBuffer().catch(() => undefined);
        await sleep(delayMs);
        continue;
      }
      const httpErrorDetails = await buildHttpErrorDetails(response);
      const elapsedMs = Date.now() - callStartedAt;
      return {
        failureCode: "http_error",
        failureClass: classifyStructuredFailure({
          failureCode: "http_error",
          statusCode: response.status,
          failureMessage: formatHttpFailureMessage(httpErrorDetails)
        }),
        failureMessage: formatHttpFailureMessage(httpErrorDetails),
        statusCode: response.status,
        attempts: attempt,
        elapsedMs,
        softTimeoutMs,
        hardTimeoutMs,
        softTimeoutExceeded: elapsedMs > softTimeoutMs
      };
    }

    const parsed = await parseResponse(response);
    const elapsedMs = Date.now() - callStartedAt;
    if (!parsed?.content) {
      return {
        failureCode: "empty_content",
        failureClass: "unknown",
        failureMessage: "Text response content was empty",
        usage: parsed?.usage,
        attempts: attempt,
        elapsedMs,
        softTimeoutMs,
        hardTimeoutMs,
        softTimeoutExceeded: elapsedMs > softTimeoutMs
      };
    }
    return {
      content: parsed.content,
      usage: parsed.usage,
      attempts: attempt,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }

  const elapsedMs = Date.now() - callStartedAt;
  return {
    failureCode: "network_error",
    failureClass: "network",
    failureMessage: "OpenAI chat request failed before receiving a response",
    attempts: retryPolicy.maxAttempts,
    elapsedMs,
    softTimeoutMs,
    hardTimeoutMs,
    softTimeoutExceeded: elapsedMs > softTimeoutMs
  };
}

export async function runOpenAiChat(options: OpenAiChatOptions): Promise<string | undefined> {
  const diagnostic = await runOpenAiChatWithDiagnostics(options);
  return diagnostic.content;
}

export async function runOpenAiStructuredChat<T>(
  options: OpenAiStructuredChatOptions,
  validator: z.ZodType<T>
): Promise<T | undefined> {
  const diagnostic = await runOpenAiStructuredChatWithDiagnostics(options, validator);
  return diagnostic.result;
}

// ─── Native tool-calling support ─────────────────────────────────────────────

export type OpenAiConversationMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAiToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ToolCallFailureCode =
  | "missing_api_key"
  | "network_error"
  | "http_error"
  | "empty_response";

export interface ToolCallDiagnostic {
  content?: string;
  toolCalls?: OpenAiToolCall[];
  finishReason?: string;
  failureCode?: ToolCallFailureCode;
  failureClass?: FailureClass;
  failureMessage?: string;
  statusCode?: number;
  httpErrorDetails?: StructuredChatHttpErrorDetails;
  usage?: LlmUsage;
  attempts?: number;
  elapsedMs?: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  softTimeoutExceeded?: boolean;
}

interface OpenAiToolCallOptions {
  apiKey?: string;
  model?: string;
  messages: OpenAiConversationMessage[];
  tools: OpenAiToolDef[];
  timeoutMs?: number;
  maxAttempts?: number;
  baseUrl?: string;
}

interface OpenAiToolCallResponsePayload {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

function parseToolCallResponse(response: Response): Promise<OpenAiToolCallResponsePayload | undefined> {
  if (!response.ok) {
    return Promise.resolve(undefined);
  }
  return response.json() as Promise<OpenAiToolCallResponsePayload>;
}

export async function runOpenAiToolCallWithDiagnostics(options: OpenAiToolCallOptions): Promise<ToolCallDiagnostic> {
  if (!options.apiKey) {
    return {
      failureCode: "missing_api_key",
      failureClass: "policy_block",
      failureMessage: "OpenAI API key is not configured",
      attempts: 0
    };
  }

  const retryPolicy = resolveRetryPolicy(options.maxAttempts);
  const softTimeoutMs = resolveSoftTimeoutMs(options.timeoutMs, 60_000);
  const hardTimeoutMs = resolveHardTimeoutMs(softTimeoutMs);
  const callStartedAt = Date.now();
  const model = options.model ?? "gpt-4o";

  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    tools: options.tools,
    tool_choice: "auto"
  };
  if (!shouldOmitTemperature(model)) {
    body.temperature = 0.2;
  }

  let response: Response | undefined;
  let attempts = 0;

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      response = await fetch(`${options.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(hardTimeoutMs)
      });
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : "Network request failed";
      if (attempt < retryPolicy.maxAttempts && isLikelyTransientNetworkError(error)) {
        const delayMs = computeRetryDelayMs(attempt, retryPolicy);
        await sleep(delayMs);
        continue;
      }
      const elapsedMs = Date.now() - callStartedAt;
      return {
        failureCode: "network_error",
        failureClass: classifyStructuredFailure({ failureCode: "network_error", failureMessage }),
        failureMessage,
        attempts: attempt,
        elapsedMs,
        softTimeoutMs,
        hardTimeoutMs,
        softTimeoutExceeded: elapsedMs > softTimeoutMs
      };
    }

    if (!response.ok) {
      if (attempt < retryPolicy.maxAttempts && isRetryableHttpStatus(response.status)) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after") ?? undefined);
        const delayMs = computeRetryDelayMs(attempt, retryPolicy, retryAfterMs);
        await response.arrayBuffer().catch(() => undefined);
        await sleep(delayMs);
        continue;
      }
      break;
    }
    break;
  }

  if (!response) {
    const elapsedMs = Date.now() - callStartedAt;
    return {
      failureCode: "network_error",
      failureClass: "network",
      failureMessage: "Tool call request failed before receiving a response",
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }

  if (!response.ok) {
    const httpErrorDetails = await buildHttpErrorDetails(response);
    const elapsedMs = Date.now() - callStartedAt;
    return {
      failureCode: "http_error",
      failureClass: classifyStructuredFailure({
        failureCode: "http_error",
        statusCode: response.status,
        failureMessage: formatHttpFailureMessage(httpErrorDetails)
      }),
      failureMessage: formatHttpFailureMessage(httpErrorDetails),
      statusCode: response.status,
      httpErrorDetails,
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }

  const payload = await parseToolCallResponse(response);
  const elapsedMs = Date.now() - callStartedAt;

  if (!payload) {
    return {
      failureCode: "empty_response",
      failureClass: "unknown",
      failureMessage: "Tool call response body was empty",
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }

  const choice = payload.choices?.[0];
  const message = choice?.message;
  const finishReason = choice?.finish_reason;
  const usage = parseUsage(payload as OpenAiResponse);

  return {
    content: message?.content?.trim() || undefined,
    toolCalls: message?.tool_calls?.length ? message.tool_calls : undefined,
    finishReason,
    usage,
    attempts,
    elapsedMs,
    softTimeoutMs,
    hardTimeoutMs,
    softTimeoutExceeded: elapsedMs > softTimeoutMs
  };
}

export async function runOpenAiStructuredChatWithDiagnostics<T>(
  options: OpenAiStructuredChatOptions,
  validator: z.ZodType<T>
): Promise<StructuredChatDiagnostic<T>> {
  const callStartedAt = Date.now();
  if (!options.apiKey) {
    return {
      failureCode: "missing_api_key",
      failureClass: "policy_block",
      failureMessage: "OpenAI API key is not configured",
      attempts: 0
    };
  }

  const retryPolicy = resolveRetryPolicy(options.maxAttempts);
  const softTimeoutMs = resolveSoftTimeoutMs(options.timeoutMs, 35_000);
  const hardTimeoutMs = resolveHardTimeoutMs(softTimeoutMs);
  const model = options.model ?? "gpt-5-mini";
  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: options.schemaName,
        schema: options.jsonSchema,
        strict: true
      }
    }
  };
  if (!shouldOmitTemperature(model)) {
    body.temperature = 0;
  }

  let response: Response | undefined;
  let attempts = 0;
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      response = await fetch(`${options.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(hardTimeoutMs)
      });
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : "Network request failed";
      if (attempt < retryPolicy.maxAttempts && isLikelyTransientNetworkError(error)) {
        const delayMs = computeRetryDelayMs(attempt, retryPolicy);
        await sleep(delayMs);
        continue;
      }
      const elapsedMs = Date.now() - callStartedAt;
      return {
        failureCode: "network_error",
        failureClass: classifyStructuredFailure({
          failureCode: "network_error",
          failureMessage
        }),
        failureMessage,
        attempts: attempt,
        elapsedMs,
        softTimeoutMs,
        hardTimeoutMs,
        softTimeoutExceeded: elapsedMs > softTimeoutMs
      };
    }

    if (!response.ok) {
      if (attempt < retryPolicy.maxAttempts && isRetryableHttpStatus(response.status)) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after") ?? undefined);
        const delayMs = computeRetryDelayMs(attempt, retryPolicy, retryAfterMs);
        await response.arrayBuffer().catch(() => undefined);
        await sleep(delayMs);
        continue;
      }
      break;
    }
    break;
  }

  if (!response) {
    const elapsedMs = Date.now() - callStartedAt;
    return {
      failureCode: "network_error",
      failureClass: "network",
      failureMessage: "OpenAI request failed before receiving a response",
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }

  if (!response.ok) {
    const httpErrorDetails = await buildHttpErrorDetails(response);
    const elapsedMs = Date.now() - callStartedAt;
    return {
      failureCode: "http_error",
      failureClass: classifyStructuredFailure({
        failureCode: "http_error",
        statusCode: response.status,
        failureMessage: formatHttpFailureMessage(httpErrorDetails)
      }),
      failureMessage: formatHttpFailureMessage(httpErrorDetails),
      statusCode: response.status,
      httpErrorDetails,
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }

  const parsed = await parseResponse(response);
  const content = parsed?.content;
  if (!content) {
    const elapsedMs = Date.now() - callStartedAt;
    return {
      failureCode: "empty_content",
      failureMessage: "Structured response content was empty",
      failureClass: "unknown",
      usage: parsed?.usage,
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    const elapsedMs = Date.now() - callStartedAt;
    return {
      failureCode: "json_parse_error",
      failureMessage: "Model response was not valid JSON",
      failureClass: "schema",
      usage: parsed?.usage,
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }

  try {
    const elapsedMs = Date.now() - callStartedAt;
    return {
      result: validator.parse(parsedJson),
      usage: parsed?.usage,
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  } catch (error) {
    const elapsedMs = Date.now() - callStartedAt;
    return {
      failureCode: "zod_validation_error",
      failureMessage: error instanceof Error ? error.message : "Schema validation failed",
      failureClass: "schema",
      usage: parsed?.usage,
      attempts,
      elapsedMs,
      softTimeoutMs,
      hardTimeoutMs,
      softTimeoutExceeded: elapsedMs > softTimeoutMs
    };
  }
}
