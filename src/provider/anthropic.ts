import { z } from "zod";
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

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicLlmProviderOptions {
  apiKey: string;
  defaultModel?: string;
}

// ─── Wire-format types ────────────────────────────────────────────────────────

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage =
  | { role: "user"; content: string | AnthropicContentBlock[] }
  | { role: "assistant"; content: string | AnthropicContentBlock[] };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  error?: { type?: string; message?: string };
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toAnthropicMessages(messages: LlmConversationMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  let system = "";
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content;
      continue;
    }

    if (msg.role === "tool") {
      // Tool results must be user messages with tool_result content blocks
      const last = result.at(-1);
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: msg.content
      };
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as AnthropicContentBlock[]).push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.toolCalls?.length) {
        const blocks: AnthropicContentBlock[] = [];
        if (msg.content) {
          blocks.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.arguments) as unknown;
          } catch {
            // leave as empty object
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        result.push({ role: "assistant", content: blocks });
      } else {
        result.push({ role: "assistant", content: msg.content ?? "" });
      }
      continue;
    }

    // user message
    result.push({ role: "user", content: msg.content });
  }

  return { system, messages: result };
}

function toAnthropicTools(tools: LlmToolDef[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}

function extractToolCalls(content: AnthropicContentBlock[]): LlmToolCall[] {
  return content
    .filter((b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      arguments: JSON.stringify(b.input)
    }));
}

function extractText(content: AnthropicContentBlock[]): string | null {
  const texts = content
    .filter((b): b is Extract<AnthropicContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text);
  return texts.length ? texts.join("") : null;
}

// ─── Raw fetch ────────────────────────────────────────────────────────────────

async function callAnthropic(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs = 90_000
): Promise<{ ok: boolean; status: number; data?: AnthropicResponse }> {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    return { ok: false, status: 0, data: { error: { type: "network_error", message } } };
  }

  let data: AnthropicResponse | undefined;
  try {
    data = (await response.json()) as AnthropicResponse;
  } catch {
    return { ok: response.ok, status: response.status };
  }
  return { ok: response.ok, status: response.status, data };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(options: AnthropicLlmProviderOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? "claude-sonnet-4-6";
  }

  async generateText(request: LlmTextRequest): Promise<LlmTextResult> {
    const model = request.model ?? this.defaultModel;
    const start = Date.now();

    const { system, messages } = toAnthropicMessages(
      request.messages.map((m) => ({ ...m, content: m.content }))
    );

    const body: Record<string, unknown> = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages
    };
    if (system) body.system = system;

    const { ok, status, data } = await callAnthropic(this.apiKey, body, request.timeoutMs);

    const elapsedMs = Date.now() - start;

    if (!ok || data?.error) {
      return {
        provider: this.name,
        failureCode: "http_error",
        failureClass: "unknown",
        failureMessage: data?.error?.message ?? `HTTP ${status}`,
        elapsedMs
      };
    }

    const text = data?.content ? extractText(data.content as AnthropicContentBlock[]) : undefined;
    if (!text) {
      return { provider: this.name, failureCode: "empty_content", failureClass: "unknown", failureMessage: "Empty response", elapsedMs };
    }

    return {
      provider: this.name,
      content: text,
      usage: data?.usage
        ? { promptTokens: data.usage.input_tokens ?? 0, completionTokens: data.usage.output_tokens ?? 0, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0), cachedTokens: data.usage.cache_read_input_tokens ?? 0 }
        : undefined,
      elapsedMs
    };
  }

  async generateStructured<T>(request: LlmStructuredRequest, validator: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
    const model = request.model ?? this.defaultModel;
    const start = Date.now();

    const { system, messages } = toAnthropicMessages(
      request.messages.map((m) => ({ ...m, content: m.content }))
    );

    // Use forced tool call for reliable structured output
    const extractTool: AnthropicTool = {
      name: request.schemaName,
      description: "Extract the required structured data.",
      input_schema: request.jsonSchema
    };

    const body: Record<string, unknown> = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages,
      tools: [extractTool],
      tool_choice: { type: "tool", name: request.schemaName }
    };
    if (system) body.system = system;

    const { ok, status, data } = await callAnthropic(this.apiKey, body, request.timeoutMs);
    const elapsedMs = Date.now() - start;

    if (!ok || data?.error) {
      return {
        provider: this.name,
        failureCode: "http_error",
        failureClass: "unknown",
        failureMessage: data?.error?.message ?? `HTTP ${status}`,
        statusCode: status,
        elapsedMs
      };
    }

    const toolUseBlock = (data?.content as AnthropicContentBlock[] | undefined)?.find(
      (b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use"
    );

    if (!toolUseBlock) {
      return { provider: this.name, failureCode: "empty_content", failureClass: "unknown", failureMessage: "No tool_use block in response", elapsedMs };
    }

    const parseResult = validator.safeParse(toolUseBlock.input);
    if (!parseResult.success) {
      return { provider: this.name, failureCode: "zod_validation_error", failureClass: "unknown", failureMessage: parseResult.error.message, elapsedMs };
    }

    return {
      provider: this.name,
      result: parseResult.data,
      usage: data?.usage
        ? { promptTokens: data.usage.input_tokens ?? 0, completionTokens: data.usage.output_tokens ?? 0, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0), cachedTokens: data.usage.cache_read_input_tokens ?? 0 }
        : undefined,
      elapsedMs
    };
  }

  async generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    const model = request.model ?? this.defaultModel;
    const start = Date.now();

    const { system, messages } = toAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages,
      tools: toAnthropicTools(request.tools)
    };
    if (system) body.system = system;

    const { ok, status, data } = await callAnthropic(this.apiKey, body, request.timeoutMs);
    const elapsedMs = Date.now() - start;

    if (!ok || data?.error) {
      return {
        provider: this.name,
        failureCode: "http_error",
        failureClass: "unknown",
        failureMessage: data?.error?.message ?? `HTTP ${status}`,
        statusCode: status,
        elapsedMs
      };
    }

    const content = data?.content as AnthropicContentBlock[] | undefined;
    const toolCalls = content ? extractToolCalls(content) : [];
    const text = content ? extractText(content) : null;
    const stopReason = data?.stop_reason;

    // Anthropic uses "tool_use" as stop_reason when tools are called, "end_turn" when done
    const finishReason = stopReason === "tool_use" ? "tool_calls" : "stop";

    return {
      provider: this.name,
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
      usage: data?.usage
        ? { promptTokens: data.usage.input_tokens ?? 0, completionTokens: data.usage.output_tokens ?? 0, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0), cachedTokens: data.usage.cache_read_input_tokens ?? 0 }
        : undefined,
      elapsedMs
    };
  }
}
