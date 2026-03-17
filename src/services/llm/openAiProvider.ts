import { z } from "zod";
import { runOpenAiChatWithDiagnostics, runOpenAiStructuredChatWithDiagnostics } from "../openAiClient.js";
import type { LlmProvider, LlmStructuredRequest, LlmStructuredResult, LlmTextRequest, LlmTextResult } from "./types.js";

interface OpenAiLlmProviderOptions {
  apiKey: string;
  defaultModel?: string;
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly defaultModel?: string;

  constructor(options: OpenAiLlmProviderOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
  }

  async generateText(request: LlmTextRequest): Promise<LlmTextResult> {
    const diagnostic = await runOpenAiChatWithDiagnostics({
      apiKey: this.apiKey,
      model: request.model ?? this.defaultModel,
      timeoutMs: request.timeoutMs,
      maxAttempts: request.maxAttempts,
      messages: request.messages
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
      failureMessage: diagnostic.failureMessage ?? "Text generation failed or returned empty content",
      attempts: diagnostic.attempts,
      elapsedMs: diagnostic.elapsedMs,
      softTimeoutMs: diagnostic.softTimeoutMs,
      hardTimeoutMs: diagnostic.hardTimeoutMs,
      softTimeoutExceeded: diagnostic.softTimeoutExceeded
    };
  }

  async generateStructured<T>(
    request: LlmStructuredRequest,
    validator: z.ZodType<T>
  ): Promise<LlmStructuredResult<T>> {
    const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
      {
        apiKey: this.apiKey,
        model: request.model ?? this.defaultModel,
        schemaName: request.schemaName,
        jsonSchema: request.jsonSchema,
        timeoutMs: request.timeoutMs,
        maxAttempts: request.maxAttempts,
        messages: request.messages
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
}
