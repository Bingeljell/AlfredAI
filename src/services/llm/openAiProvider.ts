import { z } from "zod";
import {
  runOpenAiChatWithDiagnostics,
  runOpenAiStructuredChatWithDiagnostics,
  runOpenAiToolCallWithDiagnostics,
  type OpenAiConversationMessage,
  type OpenAiToolDef
} from "../openAiClient.js";
import type {
  LlmConversationMessage,
  LlmProvider,
  LlmStructuredRequest,
  LlmStructuredResult,
  LlmTextRequest,
  LlmTextResult,
  LlmToolCall,
  LlmToolCallRequest,
  LlmToolCallResult,
  LlmToolDef
} from "./types.js";

interface OpenAiLlmProviderOptions {
  apiKey: string;
  defaultModel?: string;
  baseUrl?: string;
  name?: string;
}

function toOpenAiMessages(messages: LlmConversationMessage[]): OpenAiConversationMessage[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return { role: "tool", tool_call_id: msg.toolCallId, content: msg.content };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments }
        }))
      };
    }
    return { role: msg.role, content: msg.content ?? "" } as OpenAiConversationMessage;
  });
}

function toOpenAiToolDefs(tools: LlmToolDef[]): OpenAiToolDef[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

function toUnifiedToolCalls(raw: { id: string; function: { name: string; arguments: string } }[]): LlmToolCall[] {
  return raw.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly defaultModel?: string;
  private readonly baseUrl?: string;

  constructor(options: OpenAiLlmProviderOptions) {
    this.name = options.name ?? "openai";
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.baseUrl = options.baseUrl;
  }

  async generateText(request: LlmTextRequest): Promise<LlmTextResult> {
    const diagnostic = await runOpenAiChatWithDiagnostics({
      apiKey: this.apiKey,
      model: request.model ?? this.defaultModel,
      timeoutMs: request.timeoutMs,
      maxAttempts: request.maxAttempts,
      messages: request.messages,
      baseUrl: this.baseUrl
    });
    if (diagnostic.content) {
      return {
        provider: this.name,
        content: diagnostic.content,
        usage: diagnostic.usage,
        attempts: diagnostic.attempts,
        elapsedMs: diagnostic.elapsedMs,
        softTimeoutMs: diagnostic.softTimeoutMs,
        hardTimeoutMs: diagnostic.hardTimeoutMs,
        softTimeoutExceeded: diagnostic.softTimeoutExceeded
      };
    }
    return {
      provider: this.name,
      failureCode: diagnostic.failureCode ?? "network_error",
      failureClass: diagnostic.failureClass ?? "network",
      failureMessage: diagnostic.failureMessage ?? "Text generation failed",
      attempts: diagnostic.attempts,
      elapsedMs: diagnostic.elapsedMs,
      softTimeoutMs: diagnostic.softTimeoutMs,
      hardTimeoutMs: diagnostic.hardTimeoutMs,
      softTimeoutExceeded: diagnostic.softTimeoutExceeded
    };
  }

  async generateStructured<T>(request: LlmStructuredRequest, validator: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
    const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
      {
        apiKey: this.apiKey,
        model: request.model ?? this.defaultModel,
        schemaName: request.schemaName,
        jsonSchema: request.jsonSchema,
        timeoutMs: request.timeoutMs,
        maxAttempts: request.maxAttempts,
        messages: request.messages,
        baseUrl: this.baseUrl
      },
      validator
    );
    return {
      provider: this.name,
      result: diagnostic.result,
      failureCode: diagnostic.failureCode,
      failureClass: diagnostic.failureClass,
      failureMessage: diagnostic.failureMessage,
      statusCode: diagnostic.statusCode,
      usage: diagnostic.usage,
      attempts: diagnostic.attempts,
      elapsedMs: diagnostic.elapsedMs,
      softTimeoutMs: diagnostic.softTimeoutMs,
      hardTimeoutMs: diagnostic.hardTimeoutMs,
      softTimeoutExceeded: diagnostic.softTimeoutExceeded
    };
  }

  async generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    const diagnostic = await runOpenAiToolCallWithDiagnostics({
      apiKey: this.apiKey,
      model: request.model ?? this.defaultModel,
      messages: toOpenAiMessages(request.messages),
      tools: toOpenAiToolDefs(request.tools),
      timeoutMs: request.timeoutMs,
      maxAttempts: request.maxAttempts,
      baseUrl: this.baseUrl
    });

    if (diagnostic.failureCode) {
      return {
        provider: this.name,
        failureCode: diagnostic.failureCode,
        failureClass: diagnostic.failureClass,
        failureMessage: diagnostic.failureMessage,
        statusCode: diagnostic.statusCode,
        usage: diagnostic.usage,
        elapsedMs: diagnostic.elapsedMs
      };
    }

    return {
      provider: this.name,
      content: diagnostic.content ?? null,
      toolCalls: diagnostic.toolCalls?.length ? toUnifiedToolCalls(diagnostic.toolCalls) : undefined,
      finishReason: diagnostic.finishReason,
      usage: diagnostic.usage,
      elapsedMs: diagnostic.elapsedMs
    };
  }
}
