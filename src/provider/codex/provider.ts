import { z } from "zod";
import { CODEX_LOGIN_EXPIRED, CODEX_LOGIN_INVALID } from "./auth.js";
import { parseCodexSse, CodexProtocolError } from "./sse.js";
import { CodexTransport } from "./transport.js";
import type {
  LlmConversationMessage,
  LlmMessage,
  LlmProvider,
  LlmStructuredRequest,
  LlmStructuredResult,
  LlmTextRequest,
  LlmTextResult,
  LlmToolCallRequest,
  LlmToolCallResult
} from "../types.js";
import type { LlmUsage } from "../../types.js";
import type { FailureClass } from "../../utils/reliability.js";
import type { CodexParsedResponse, CodexTransportFailure, CodexTransportSuccess } from "./types.js";

export interface CodexLlmProviderOptions {
  authFilePath?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

interface CodexCallResult {
  parsed?: CodexParsedResponse;
  transport?: CodexTransportSuccess;
  failureCode?: string;
  failureClass?: FailureClass;
  failureMessage?: string;
  statusCode?: number;
  usage?: LlmUsage;
  elapsedMs: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  softTimeoutExceeded?: boolean;
}

function asConversationMessages(messages: LlmMessage[]): LlmConversationMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function failureFromTransport(result: CodexTransportFailure): CodexCallResult {
  return {
    failureCode: result.failureCode,
    failureClass: result.failureClass,
    failureMessage: result.failureMessage,
    statusCode: result.statusCode,
    usage: undefined,
    elapsedMs: result.elapsedMs,
    softTimeoutMs: result.softTimeoutMs,
    hardTimeoutMs: result.hardTimeoutMs,
    softTimeoutExceeded: result.softTimeoutExceeded
  };
}

function safeUnexpectedFailure(error: unknown, elapsedMs: number, signal?: AbortSignal): CodexCallResult {
  if (signal?.aborted) {
    const deadline = signal.reason === "deadline" || signal.reason === "timeout";
    return {
      failureCode: "cancelled",
      failureClass: deadline ? "timeout" : "unknown",
      failureMessage: deadline ? "Codex request timed out." : "Codex request was cancelled.",
      elapsedMs
    };
  }
  const message = error instanceof Error ? error.message : "";
  if (message === CODEX_LOGIN_EXPIRED) {
    return { failureCode: "codex_login_expired", failureClass: "policy_block", failureMessage: CODEX_LOGIN_EXPIRED, elapsedMs };
  }
  if (message === CODEX_LOGIN_INVALID) {
    return { failureCode: "codex_login_invalid", failureClass: "policy_block", failureMessage: CODEX_LOGIN_INVALID, elapsedMs };
  }
  return { failureCode: "network_error", failureClass: "network", failureMessage: "Codex request failed.", elapsedMs };
}

export class CodexLlmProvider implements LlmProvider {
  readonly name = "codex";
  private readonly defaultModel?: string;
  private readonly transport: CodexTransport;

  constructor(options: CodexLlmProviderOptions = {}) {
    this.defaultModel = options.defaultModel;
    this.transport = new CodexTransport({ authFilePath: options.authFilePath, fetchImpl: options.fetchImpl });
  }

  private async call(args: {
    model?: string;
    messages: LlmConversationMessage[];
    tools?: LlmToolCallRequest["tools"];
    text?: Record<string, unknown>;
    timeoutMs?: number;
    maxAttempts?: number;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<CodexCallResult> {
    const model = args.model ?? this.defaultModel;
    const start = Date.now();
    if (!model?.trim()) {
      return { failureCode: "missing_model", failureClass: "policy_block", failureMessage: "Codex model is not configured.", elapsedMs: 0 };
    }

    let transportResult;
    try {
      transportResult = await this.transport.request({
        model,
        messages: args.messages,
        tools: args.tools,
        text: args.text,
        timeoutMs: args.timeoutMs,
        maxAttempts: args.maxAttempts,
        sessionId: args.sessionId,
        signal: args.signal
      });
    } catch (error) {
      return safeUnexpectedFailure(error, Date.now() - start, args.signal);
    }
    if (!transportResult.ok) return failureFromTransport(transportResult);

    if (!transportResult.response.body) {
      return {
        failureCode: "protocol_error",
        failureClass: "unknown",
        failureMessage: "Codex returned an empty response stream.",
        statusCode: undefined,
        elapsedMs: Date.now() - start,
        softTimeoutMs: transportResult.softTimeoutMs,
        hardTimeoutMs: transportResult.hardTimeoutMs,
        softTimeoutExceeded: transportResult.softTimeoutExceeded
      };
    }

    let parsed: CodexParsedResponse;
    const streamController = new AbortController();
    const onAbort = () => streamController.abort(args.signal?.reason ?? "caller_cancellation");
    args.signal?.addEventListener("abort", onAbort, { once: true });
    if (args.signal?.aborted) onAbort();
    const streamTimeoutMs = transportResult.hardTimeoutMs ?? 90_000;
    const streamTimeout = setTimeout(() => streamController.abort("timeout"), streamTimeoutMs);
    streamTimeout.unref?.();
    try {
      parsed = await parseCodexSse(transportResult.response.body, streamController.signal);
    } catch (error) {
      if (streamController.signal.aborted) return safeUnexpectedFailure(error, Date.now() - start, streamController.signal);
      const protocol = error instanceof CodexProtocolError;
      return {
        failureCode: protocol ? "protocol_error" : "protocol_error",
        failureClass: "unknown",
        failureMessage: "Codex response stream was invalid.",
        elapsedMs: Date.now() - start,
        softTimeoutMs: transportResult.softTimeoutMs,
        hardTimeoutMs: transportResult.hardTimeoutMs,
        softTimeoutExceeded: transportResult.softTimeoutExceeded
      };
    } finally {
      clearTimeout(streamTimeout);
      args.signal?.removeEventListener("abort", onAbort);
    }

    const elapsedMs = Date.now() - start;
    if (parsed.failureCode) {
      const failureClass: FailureClass = parsed.failureCode === "rate_limit" ? "network" : parsed.failureCode === "policy_block" ? "policy_block" : parsed.failureCode === "length" ? "unknown" : "unknown";
      return {
        failureCode: parsed.failureCode,
        failureClass,
        failureMessage: parsed.failureMessage ?? "Codex did not complete the response.",
        usage: parsed.usage,
        elapsedMs,
        softTimeoutMs: transportResult.softTimeoutMs,
        hardTimeoutMs: transportResult.hardTimeoutMs,
        softTimeoutExceeded: transportResult.softTimeoutExceeded
      };
    }
    if (parsed.status === "cancelled") {
      return {
        failureCode: "cancelled",
        failureClass: args.signal?.reason === "deadline" ? "timeout" : "unknown",
        failureMessage: args.signal?.reason === "deadline" ? "Codex request timed out." : "Codex request was cancelled.",
        usage: parsed.usage,
        elapsedMs
      };
    }
    return {
      parsed,
      transport: transportResult,
      usage: parsed.usage,
      elapsedMs,
      softTimeoutMs: transportResult.softTimeoutMs,
      hardTimeoutMs: transportResult.hardTimeoutMs,
      softTimeoutExceeded: transportResult.softTimeoutExceeded
    };
  }

  async generateText(request: LlmTextRequest): Promise<LlmTextResult> {
    const result = await this.call({
      model: request.model,
      messages: asConversationMessages(request.messages),
      timeoutMs: request.timeoutMs,
      maxAttempts: request.maxAttempts,
      sessionId: request.sessionId,
      signal: request.signal
    });
    if (result.failureCode) {
      return {
        provider: this.name,
        failureCode: result.failureCode,
        failureClass: result.failureClass,
        failureMessage: result.failureMessage,
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        softTimeoutMs: result.softTimeoutMs,
        hardTimeoutMs: result.hardTimeoutMs,
        softTimeoutExceeded: result.softTimeoutExceeded
      };
    }
    const content = result.parsed?.content?.trim();
    if (!content) {
      return {
        provider: this.name,
        failureCode: "empty_content",
        failureClass: "unknown",
        failureMessage: "Codex returned no text.",
        usage: result.usage,
        elapsedMs: result.elapsedMs
      };
    }
    return {
      provider: this.name,
      content,
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      softTimeoutMs: result.softTimeoutMs,
      hardTimeoutMs: result.hardTimeoutMs,
      softTimeoutExceeded: result.softTimeoutExceeded
    };
  }

  async generateStructured<T>(request: LlmStructuredRequest, validator: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
    const result = await this.call({
      model: request.model,
      messages: asConversationMessages(request.messages),
      text: {
        format: {
          type: "json_schema",
          name: request.schemaName,
          schema: request.jsonSchema,
          strict: true
        }
      },
      timeoutMs: request.timeoutMs,
      maxAttempts: request.maxAttempts,
      sessionId: request.sessionId,
      signal: request.signal
    });
    const base = {
      provider: this.name,
      failureCode: result.failureCode,
      failureClass: result.failureClass,
      failureMessage: result.failureMessage,
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      softTimeoutMs: result.softTimeoutMs,
      hardTimeoutMs: result.hardTimeoutMs,
      softTimeoutExceeded: result.softTimeoutExceeded
    };
    if (result.failureCode) return base;
    const content = result.parsed?.content?.trim();
    if (!content) return { ...base, failureCode: "empty_content", failureClass: "unknown", failureMessage: "Codex returned no structured output." };
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return { ...base, failureCode: "json_parse_error", failureClass: "schema", failureMessage: "Codex returned invalid JSON." };
    }
    const validated = validator.safeParse(value);
    if (!validated.success) return { ...base, failureCode: "zod_validation_error", failureClass: "schema", failureMessage: validated.error.message };
    return { ...base, result: validated.data };
  }

  async generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    const result = await this.call({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      timeoutMs: request.timeoutMs,
      maxAttempts: request.maxAttempts,
      sessionId: request.sessionId,
      signal: request.signal
    });
    if (result.failureCode) {
      return {
        provider: this.name,
        failureCode: result.failureCode,
        failureClass: result.failureClass,
        failureMessage: result.failureMessage,
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        statusCode: result.statusCode
      };
    }
    const parsed = result.parsed!;
    const toolCalls = parsed.toolCalls.length ? parsed.toolCalls : undefined;
    return {
      provider: this.name,
      content: parsed.content,
      toolCalls,
      finishReason: toolCalls ? "tool_calls" : "stop",
      providerState: toolCalls ? parsed.providerState : undefined,
      usage: result.usage,
      elapsedMs: result.elapsedMs
    };
  }
}
