import type { ConversationSnapshot, RunStatus, SessionRecord } from "../types.js";
import { randomUUID } from "node:crypto";

export interface TurnResponse {
  runId: string;
  status: RunStatus;
  assistantText?: string;
}

/** SSE framing is independent of network chunks (including split UTF-8). */
export async function* readSnapshots(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<ConversationSnapshot, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Conversation stream timed out")), 45_000);
        })
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize only complete CRLF pairs; a CR may straddle chunks.
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (event === "snapshot") {
          const snapshot = JSON.parse(data.join("\n")) as ConversationSnapshot;
          if (!snapshot.session?.id || !Array.isArray(snapshot.runs)) throw new Error("Invalid conversation snapshot");
          yield snapshot;
        }
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error("Conversation snapshot exceeds 16 MiB");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class GatewayClient {
  private readonly pendingRequests = new Map<string, string>();
  constructor(readonly url: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", ...(this.apiKey ? { "X-Api-Key": this.apiKey } : {}) };
  }

  private async response(route: string, init: RequestInit): Promise<Response> {
    const response = await this.fetcher(`${this.url.replace(/\/$/, "")}${route}`, {
      ...init, headers: this.headers(), redirect: "error"
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new Error("Authentication failed. Check ALFRED_API_KEY or the gateway workspace/api-key file.");
      throw new Error(`Gateway returned HTTP ${response.status}`);
    }
    return response;
  }

  private async json<T>(route: string, init: RequestInit = {}): Promise<T> {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    return (await this.response(route, { ...init, signal })).json() as Promise<T>;
  }

  async sessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    return (await this.json<{ sessions: SessionRecord[] }>("/v1/sessions?limit=100", { signal })).sessions;
  }

  async create(name: string, signal?: AbortSignal): Promise<SessionRecord> {
    return (await this.json<{ session: SessionRecord }>("/v1/sessions", {
      method: "POST", body: JSON.stringify({ action: "create", name }), signal
    })).session;
  }

  async submit(sessionId: string, message: string, signal: AbortSignal): Promise<TurnResponse> {
    // A manual retry of the same uncertain submission reuses its durable key.
    const key = JSON.stringify([sessionId, message]);
    const requestId = this.pendingRequests.get(key) ?? randomUUID();
    this.pendingRequests.set(key, requestId);
    const response = await this.response("/v1/chat/turn", {
      method: "POST", body: JSON.stringify({ sessionId, message, requestJob: true, surface: "tui", requestId }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    });
    const result = await response.json() as TurnResponse;
    this.pendingRequests.delete(key);
    return result;
  }

  async cancel(runId: string, signal?: AbortSignal): Promise<string> {
    return (await this.json<{ message: string }>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", signal })).message;
  }

  async *watch(sessionId: string, signal: AbortSignal): AsyncGenerator<ConversationSnapshot, void> {
    const response = await this.response(`/v1/sessions/${encodeURIComponent(sessionId)}/stream`, { signal });
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Gateway does not support conversation streaming; restart it with the updated code.");
    yield* readSnapshots(response.body, signal);
  }
}
