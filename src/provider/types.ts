import type { z } from "zod";
import type { FailureClass } from "../utils/reliability.js";
import type { LlmUsage } from "../types.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── Unified tool-calling types (provider-agnostic) ──────────────────────────

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export type LlmConversationMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface LlmToolCallRequest {
  messages: LlmConversationMessage[];
  tools: LlmToolDef[];
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface LlmToolCallResult {
  provider: string;
  content?: string | null;
  toolCalls?: LlmToolCall[];
  finishReason?: string;
  failureCode?: string;
  failureClass?: FailureClass;
  failureMessage?: string;
  statusCode?: number;
  usage?: LlmUsage;
  elapsedMs?: number;
}

// ─── Text and structured types ────────────────────────────────────────────────

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

// ─── Provider interface ───────────────────────────────────────────────────────

export interface LlmProvider {
  name: string;
  generateText(request: LlmTextRequest): Promise<LlmTextResult>;
  generateStructured<T>(request: LlmStructuredRequest, validator: z.ZodType<T>): Promise<LlmStructuredResult<T>>;
  generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult>;
}
