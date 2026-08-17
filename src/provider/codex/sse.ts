import type { LlmToolCall } from "../types.js";
import type {
  CodexJsonObject,
  CodexParsedResponse,
  CodexResponsesOutputItem,
  CodexResponseWire,
  CodexSseEvent
} from "./types.js";

export class CodexProtocolError extends Error {
  readonly code = "protocol_error";

  constructor(message = "Codex response stream was malformed") {
    super(message);
    this.name = "CodexProtocolError";
  }
}

function parseSseEvent(lines: string[]): CodexSseEvent | undefined {
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== "data") continue;
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  }
  if (!dataLines.length) return undefined;
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as CodexSseEvent;
  } catch {
    throw new CodexProtocolError("Codex response contained invalid event data");
  }
}

function consumeLines(text: string, flush = false): { events: CodexSseEvent[]; remainder: string } {
  const events: CodexSseEvent[] = [];
  let remainder = text;
  const lines: string[] = [];

  while (true) {
    const match = /\r?\n/.exec(remainder);
    if (!match) break;
    const line = remainder.slice(0, match.index);
    remainder = remainder.slice(match.index + match[0].length);
    if (line === "") {
      const event = parseSseEvent(lines.splice(0, lines.length));
      if (event) events.push(event);
    } else {
      lines.push(line);
    }
  }

  if (flush) {
    if (remainder) lines.push(remainder);
    const event = parseSseEvent(lines);
    if (event) events.push(event);
    remainder = "";
  }

  // Preserve an unfinished event across chunks. The caller keeps the line
  // buffer, so this function only handles complete line boundaries.
  if (lines.length) {
    // Lines can only remain here when there was no terminating blank line.
    // Reconstruct them with LF; SSE semantics do not depend on original CRLF.
    remainder = `${lines.join("\n")}\n${remainder}`;
  }
  return { events, remainder };
}

type SseSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

/** Yield parsed SSE JSON events from arbitrary byte/string chunk boundaries. */
export async function* parseSseEvents(source: SseSource, signal?: AbortSignal): AsyncGenerator<CodexSseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    void reader?.cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (source instanceof ReadableStream) {
      reader = source.getReader();
      while (!aborted) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const parsed = consumeLines(buffer);
        buffer = parsed.remainder;
        for (const event of parsed.events) yield event;
      }
    } else {
      for await (const chunk of source) {
        if (aborted) break;
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        const parsed = consumeLines(buffer);
        buffer = parsed.remainder;
        for (const event of parsed.events) yield event;
      }
    }
    buffer += decoder.decode();
    const parsed = consumeLines(buffer, true);
    for (const event of parsed.events) yield event;
    if (aborted) throw new CodexProtocolError("Codex response stream was cancelled");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (aborted) await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function outputItemsFromResponse(response: CodexResponseWire | undefined): CodexResponsesOutputItem[] {
  return Array.isArray(response?.output)
      ? response.output.filter((item): item is CodexResponsesOutputItem => Boolean(item && typeof item === "object"))
    : [];
}

function outputItemKey(item: CodexResponsesOutputItem, index?: unknown): string {
  if (typeof item.id === "string") return `id:${item.id}`;
  if (typeof item.call_id === "string") return `call:${item.call_id}`;
  return `index:${typeof index === "number" ? index : "unknown"}`;
}

function textFromOutputItems(items: CodexResponsesOutputItem[]): string {
  const texts: string[] = [];
  for (const item of items) {
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as CodexJsonObject;
      if (record.type === "output_text" && typeof record.text === "string") texts.push(record.text);
    }
  }
  return texts.join("");
}

function hasRefusal(items: CodexResponsesOutputItem[]): boolean {
  return items.some((item) => Array.isArray(item.content) && item.content.some((part) => {
    return Boolean(part && typeof part === "object" && (part as CodexJsonObject).type === "refusal");
  }));
}

function toUsage(response: CodexResponseWire | undefined) {
  const usage = response?.usage;
  if (!usage) return undefined;
  const numberOrZero = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const result = {
    promptTokens: numberOrZero(usage.input_tokens),
    completionTokens: numberOrZero(usage.output_tokens),
    totalTokens: numberOrZero(usage.total_tokens),
    cachedTokens: numberOrZero(usage.input_tokens_details?.cached_tokens)
  };
  return result.promptTokens || result.completionTokens || result.totalTokens ? result : undefined;
}

function safeEventFailure(event: CodexSseEvent): { code: string; message: string } {
  const errorCode = typeof event.error?.code === "string" ? event.error.code : undefined;
  if (errorCode === "rate_limit" || errorCode === "usage_limit") return { code: "rate_limit", message: "Codex subscription usage limit reached." };
  return { code: "provider_error", message: "Codex returned a failed response." };
}

/** Accumulate a parsed Codex SSE event sequence into one provider result. */
export function accumulateCodexEvents(events: Iterable<CodexSseEvent>): CodexParsedResponse {
  let content = "";
  let reasoningSummary = "";
  let response: CodexResponseWire | undefined;
  let status: string | undefined;
  let terminalEvent: string | undefined;
  let failureCode: string | undefined;
  let failureMessage: string | undefined;
  let refusal = false;
  const items = new Map<string, CodexResponsesOutputItem>();
  const argumentDeltas = new Map<string, { id: string; name: string; callId?: string; arguments: string }>();

  for (const event of events) {
    const type = asString(event.type) ?? "";
    if (type === "response.output_text.delta") {
      content += asString(event.delta) ?? "";
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_summary.delta") {
      reasoningSummary += asString(event.delta) ?? "";
    } else if (type === "response.refusal.delta") {
      refusal = true;
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      if (event.item && typeof event.item === "object") {
        const key = outputItemKey(event.item, event.output_index);
        items.set(key, { ...items.get(key), ...event.item });
      }
    } else if (type === "response.function_call_arguments.delta") {
      const id = asString(event.item_id) ?? `index-${String(event.output_index ?? "unknown")}`;
      const current = argumentDeltas.get(id) ?? {
        id,
        name: asString(event.name) ?? "",
        callId: asString(event.call_id),
        arguments: ""
      };
      current.arguments += asString(event.delta) ?? "";
      if (!current.name && asString(event.name)) current.name = asString(event.name)!;
      if (!current.callId && asString(event.call_id)) current.callId = asString(event.call_id);
      argumentDeltas.set(id, current);
    } else if (type === "response.function_call_arguments.done") {
      const id = asString(event.item_id) ?? `index-${String(event.output_index ?? "unknown")}`;
      const current = argumentDeltas.get(id) ?? {
        id,
        name: asString(event.name) ?? "",
        callId: asString(event.call_id),
        arguments: ""
      };
      if (typeof event.arguments === "string") current.arguments = event.arguments;
      if (asString(event.name)) current.name = asString(event.name)!;
      if (asString(event.call_id)) current.callId = asString(event.call_id);
      argumentDeltas.set(id, current);
    } else if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
      terminalEvent = type;
      response = event.response;
      status = asString(response?.status) ?? (type === "response.incomplete" ? "incomplete" : "completed");
      for (const item of outputItemsFromResponse(response)) items.set(outputItemKey(item), item);
      if (type === "response.incomplete" || status === "incomplete") failureCode = "length";
      if (status === "failed") {
        failureCode = "provider_error";
        failureMessage = "Codex returned a failed response.";
      }
    } else if (type === "response.failed" || type === "error") {
      const safe = safeEventFailure(event);
      failureCode = safe.code;
      failureMessage = safe.message;
      terminalEvent = type;
      response = event.response;
      status = "failed";
    }
  }

  const outputItems = [...items.values()];
  if (!content && outputItems.length) content = textFromOutputItems(outputItems);
  refusal ||= hasRefusal(outputItems);
  const toolCalls: LlmToolCall[] = [];
  for (const call of argumentDeltas.values()) {
    const matchingItem = outputItems.find((item) => item.id === call.id || item.call_id === call.callId);
    if (matchingItem) {
      if (!call.callId && typeof matchingItem.call_id === "string") call.callId = matchingItem.call_id;
      if (!call.name && typeof matchingItem.name === "string") call.name = matchingItem.name;
      if ((!matchingItem.arguments || matchingItem.arguments === "{}") && call.arguments) matchingItem.arguments = call.arguments;
    }
  }
  for (const item of outputItems) {
    if (item.type !== "function_call") continue;
    if (typeof item.call_id !== "string" || typeof item.name !== "string") continue;
    toolCalls.push({
      id: item.call_id,
      name: item.name,
      arguments: typeof item.arguments === "string" ? item.arguments : "{}"
    });
  }
  for (const call of argumentDeltas.values()) {
    if (!call.callId || !call.name || toolCalls.some((existing) => existing.id === call.callId)) continue;
    toolCalls.push({ id: call.callId, name: call.name, arguments: call.arguments || "{}" });
    outputItems.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments || "{}" });
  }

  if (!terminalEvent) throw new CodexProtocolError("Codex response stream ended without a terminal event");
  if (failureCode) return { content: content || null, toolCalls, outputItems, usage: toUsage(response), status, terminalEvent, refusal, failureCode, failureMessage };
  if (refusal) return { content: content || null, toolCalls, outputItems, usage: toUsage(response), status, terminalEvent, refusal, failureCode: "policy_block", failureMessage: "Codex declined to provide that response." };

  return {
    content: content || null,
    toolCalls,
    outputItems,
    providerState: outputItems.length ? { provider: "codex", data: { outputItems } } : undefined,
    usage: toUsage(response),
    status,
    terminalEvent,
    ...(reasoningSummary ? { reasoningSummary } : {})
  } as CodexParsedResponse & { reasoningSummary?: string };
}

export async function parseCodexSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<CodexParsedResponse> {
  const events: CodexSseEvent[] = [];
  for await (const event of parseSseEvents(body, signal)) events.push(event);
  return accumulateCodexEvents(events);
}

export async function parseCodexSseText(text: string): Promise<CodexParsedResponse> {
  async function* chunks(): AsyncGenerator<string> { yield text; }
  const events: CodexSseEvent[] = [];
  for await (const event of parseSseEvents(chunks())) events.push(event);
  return accumulateCodexEvents(events);
}

export const parseSseStream = parseCodexSse;
