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

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiLlmProviderOptions {
  apiKey: string;
  defaultModel?: string;
}

// ─── Wire-format types ────────────────────────────────────────────────────────

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: unknown } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toGeminiContents(messages: LlmConversationMessage[]): {
  systemInstruction: string;
  contents: GeminiContent[];
} {
  let systemInstruction = "";
  const contents: GeminiContent[] = [];
  // Track toolCallId → toolName for functionResponse messages
  const toolCallNames = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = msg.content;
      continue;
    }

    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          toolCallNames.set(tc.id, tc.name);
          let args: unknown = {};
          try {
            args = JSON.parse(tc.arguments) as unknown;
          } catch {
            // leave empty
          }
          parts.push({ functionCall: { name: tc.name, args } });
        }
      }
      contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      const toolName = toolCallNames.get(msg.toolCallId) ?? msg.toolName;
      let responseContent: unknown;
      try {
        responseContent = JSON.parse(msg.content) as unknown;
      } catch {
        responseContent = { content: msg.content };
      }
      // Tool results are user messages with functionResponse parts
      const last = contents.at(-1);
      const part: GeminiPart = { functionResponse: { name: toolName, response: responseContent } };
      if (last?.role === "user") {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }

    // user
    contents.push({ role: "user", parts: [{ text: msg.content }] });
  }

  return { systemInstruction, contents };
}

function extractGeminiToolCalls(parts: GeminiPart[]): LlmToolCall[] {
  const calls: LlmToolCall[] = [];
  for (const part of parts) {
    if ("functionCall" in part) {
      calls.push({
        id: `gemini-${part.functionCall.name}-${Date.now()}`,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args)
      });
    }
  }
  return calls;
}

function extractGeminiText(parts: GeminiPart[]): string | null {
  const texts = parts.filter((p): p is { text: string } => "text" in p).map((p) => p.text);
  return texts.length ? texts.join("") : null;
}

// ─── Raw fetch ────────────────────────────────────────────────────────────────

async function callGemini(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  timeoutMs = 90_000
): Promise<{ ok: boolean; status: number; data?: GeminiResponse }> {
  const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    return { ok: false, status: 0, data: { error: { message } } };
  }

  let data: GeminiResponse | undefined;
  try {
    data = (await response.json()) as GeminiResponse;
  } catch {
    return { ok: response.ok, status: response.status };
  }
  return { ok: response.ok, status: response.status, data };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GeminiLlmProvider implements LlmProvider {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(options: GeminiLlmProviderOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? "gemini-2.0-flash";
  }

  async generateText(request: LlmTextRequest): Promise<LlmTextResult> {
    const model = request.model ?? this.defaultModel;
    const start = Date.now();

    const { systemInstruction, contents } = toGeminiContents(
      request.messages.map((m) => ({ ...m }))
    );

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const { ok, status, data } = await callGemini(this.apiKey, model, body, request.timeoutMs);
    const elapsedMs = Date.now() - start;

    if (!ok || data?.error) {
      return { provider: this.name, failureCode: "http_error", failureClass: "unknown", failureMessage: data?.error?.message ?? `HTTP ${status}`, elapsedMs };
    }

    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const text = extractGeminiText(parts);
    if (!text) {
      return { provider: this.name, failureCode: "empty_content", failureClass: "unknown", failureMessage: "Empty response", elapsedMs };
    }

    const um = data?.usageMetadata;
    return {
      provider: this.name,
      content: text,
      usage: um ? { promptTokens: um.promptTokenCount ?? 0, completionTokens: um.candidatesTokenCount ?? 0, totalTokens: um.totalTokenCount ?? 0 } : undefined,
      elapsedMs
    };
  }

  async generateStructured<T>(request: LlmStructuredRequest, validator: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
    const model = request.model ?? this.defaultModel;
    const start = Date.now();

    const { systemInstruction, contents } = toGeminiContents(
      request.messages.map((m) => ({ ...m }))
    );

    // Use forced function call for structured output
    const body: Record<string, unknown> = {
      contents,
      tools: [{ functionDeclarations: [{ name: request.schemaName, description: "Extract structured data.", parameters: request.jsonSchema }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [request.schemaName] } }
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const { ok, status, data } = await callGemini(this.apiKey, model, body, request.timeoutMs);
    const elapsedMs = Date.now() - start;

    if (!ok || data?.error) {
      return { provider: this.name, failureCode: "http_error", failureClass: "unknown", failureMessage: data?.error?.message ?? `HTTP ${status}`, statusCode: status, elapsedMs };
    }

    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const fnCall = parts.find((p): p is { functionCall: { name: string; args: unknown } } => "functionCall" in p);
    if (!fnCall) {
      return { provider: this.name, failureCode: "empty_content", failureClass: "unknown", failureMessage: "No functionCall in response", elapsedMs };
    }

    const parseResult = validator.safeParse(fnCall.functionCall.args);
    if (!parseResult.success) {
      return { provider: this.name, failureCode: "zod_validation_error", failureClass: "unknown", failureMessage: parseResult.error.message, elapsedMs };
    }

    const um = data?.usageMetadata;
    return {
      provider: this.name,
      result: parseResult.data,
      usage: um ? { promptTokens: um.promptTokenCount ?? 0, completionTokens: um.candidatesTokenCount ?? 0, totalTokens: um.totalTokenCount ?? 0 } : undefined,
      elapsedMs
    };
  }

  async generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    const model = request.model ?? this.defaultModel;
    const start = Date.now();

    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const functionDeclarations: GeminiFunctionDeclaration[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));

    const body: Record<string, unknown> = {
      contents,
      tools: [{ functionDeclarations }]
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const { ok, status, data } = await callGemini(this.apiKey, model, body, request.timeoutMs);
    const elapsedMs = Date.now() - start;

    if (!ok || data?.error) {
      return { provider: this.name, failureCode: "http_error", failureClass: "unknown", failureMessage: data?.error?.message ?? `HTTP ${status}`, statusCode: status, elapsedMs };
    }

    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const toolCalls = extractGeminiToolCalls(parts);
    const text = extractGeminiText(parts);
    const finishReason = toolCalls.length ? "tool_calls" : "stop";

    const um = data?.usageMetadata;
    return {
      provider: this.name,
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason,
      usage: um ? { promptTokens: um.promptTokenCount ?? 0, completionTokens: um.candidatesTokenCount ?? 0, totalTokens: um.totalTokenCount ?? 0 } : undefined,
      elapsedMs
    };
  }
}
