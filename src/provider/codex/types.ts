import type { LlmConversationMessage, LlmProviderState, LlmToolCall, LlmToolDef } from "../types.js";
import type { LlmUsage } from "../../types.js";

export type CodexJsonObject = Record<string, unknown>;

export type CodexResponsesInputItem = CodexJsonObject & {
  type?: string;
  role?: string;
};

export type CodexResponsesOutputItem = CodexJsonObject & {
  id?: string;
  type?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

export interface CodexUsageWire extends CodexJsonObject {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown };
}

export interface CodexResponseWire extends CodexJsonObject {
  id?: string;
  status?: string;
  output?: unknown;
  usage?: CodexUsageWire;
  incomplete_details?: CodexJsonObject;
  error?: CodexJsonObject;
}

export interface CodexSseEvent extends CodexJsonObject {
  type?: string;
  response?: CodexResponseWire;
  delta?: unknown;
  item?: CodexResponsesOutputItem;
  output_index?: unknown;
  item_id?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
  error?: CodexJsonObject;
}

export interface CodexMessageTranslation {
  instructions?: string;
  input: CodexResponsesInputItem[];
}

export interface CodexRequestBody extends CodexJsonObject {
  model: string;
  store: false;
  stream: true;
  instructions?: string;
  input: CodexResponsesInputItem[];
  text: CodexJsonObject;
  include: ["reasoning.encrypted_content"];
  prompt_cache_key?: string;
  tool_choice: "auto";
  parallel_tool_calls: true;
  tools?: CodexJsonObject[];
}

export interface CodexParsedResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  outputItems: CodexResponsesOutputItem[];
  providerState?: LlmProviderState;
  usage?: LlmUsage;
  status?: string;
  terminalEvent?: string;
  refusal?: boolean;
  failureCode?: string;
  failureMessage?: string;
}

export interface CodexTransportRequest {
  model: string;
  messages: LlmConversationMessage[];
  tools?: LlmToolDef[];
  text?: CodexJsonObject;
  sessionId?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface CodexTransportSuccess {
  ok: true;
  response: Response;
  attempts: number;
  elapsedMs: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  softTimeoutExceeded?: boolean;
}

export interface CodexTransportFailure {
  ok: false;
  failureCode: string;
  failureClass: "network" | "timeout" | "schema" | "policy_block" | "unknown";
  failureMessage: string;
  statusCode?: number;
  attempts: number;
  elapsedMs: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  softTimeoutExceeded?: boolean;
}

export type CodexTransportResult = CodexTransportSuccess | CodexTransportFailure;
