import type { z } from "zod";
import type { FailureClass } from "../../core/reliability.js";
import type { LlmUsage } from "../../types.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmTextRequest {
  messages: LlmMessage[];
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface LlmStructuredRequest extends LlmTextRequest {
  schemaName: string;
  jsonSchema: Record<string, unknown>;
}

export interface LlmTextResult {
  provider: string;
  content?: string;
  failureCode?: string;
  failureClass?: FailureClass;
  failureMessage?: string;
  attempts?: number;
  usage?: LlmUsage;
  elapsedMs?: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  softTimeoutExceeded?: boolean;
}

export interface LlmStructuredResult<T> {
  provider: string;
  result?: T;
  failureCode?: string;
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

export interface LlmProvider {
  name: string;
  generateText(request: LlmTextRequest): Promise<LlmTextResult>;
  generateStructured<T>(request: LlmStructuredRequest, validator: z.ZodType<T>): Promise<LlmStructuredResult<T>>;
}
