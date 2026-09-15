import type {
  AppServerClientOptions,
  AppServerNotification,
  AppServerServerRequest,
  CodexAppServerClient
} from "./appServerClient.js";
import { CodexAppServerClient as DefaultCodexAppServerClient } from "./appServerClient.js";
import type { LlmUsage } from "../../types.js";

export interface CodexDynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
}

export interface AppServerTurnClient {
  initialize(params: unknown): Promise<Record<string, unknown>>;
  request<T>(method: string, params: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  interruptTurn(threadId: string, turnId: string, options?: { timeoutMs?: number }): Promise<void>;
  close(): Promise<void>;
}

export type AppServerClientFactory = (options: AppServerClientOptions) => AppServerTurnClient;

export interface DynamicToolCallParams {
  callId: string;
  namespace: string | null;
  threadId: string;
  tool: string;
  arguments: unknown;
  turnId: string;
}

export interface SafeAppServerTurnOptions {
  model: string;
  effort?: string;
  baseInstructions: string;
  input: string;
  history?: unknown[];
  outputSchema?: Record<string, unknown>;
  dynamicTools?: CodexDynamicToolSpec[];
  timeoutMs: number;
  signal?: AbortSignal;
  clientFactory?: AppServerClientFactory;
  onDynamicTool?: (params: DynamicToolCallParams) => Promise<Record<string, unknown>>;
  onNotification?: (notification: AppServerNotification) => void;
  onCrash?: (error: Error) => void;
}

export interface SafeAppServerTurnResult {
  status: "completed" | "interrupted" | "failed" | "timeout";
  content: string;
  usage?: LlmUsage;
  error?: string;
  threadId?: string;
  turnId?: string;
  elapsedMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Codex App Server turn failed").slice(0, 300);
}

function extractId(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value[key]) ? value[key] : undefined;
  return asString(nested?.id);
}

function mapUsage(params: unknown): LlmUsage | undefined {
  if (!isRecord(params) || !isRecord(params.tokenUsage)) return undefined;
  const tokenUsage = params.tokenUsage;
  const last = isRecord(tokenUsage.last) ? tokenUsage.last : isRecord(tokenUsage.total) ? tokenUsage.total : undefined;
  if (!last) return undefined;
  const numberValue = (key: string): number => typeof last[key] === "number" && Number.isFinite(last[key]) ? last[key] as number : 0;
  return {
    promptTokens: numberValue("inputTokens"),
    completionTokens: numberValue("outputTokens"),
    totalTokens: numberValue("totalTokens"),
    cachedTokens: numberValue("cachedInputTokens"),
    reasoningTokens: numberValue("reasoningOutputTokens")
  };
}

export function buildSafeThreadStartParams(options: {
  model: string;
  baseInstructions: string;
  dynamicTools?: CodexDynamicToolSpec[];
}): Record<string, unknown> {
  return {
    ephemeral: true,
    model: options.model,
    dynamicTools: options.dynamicTools ?? [],
    environments: [],
    runtimeWorkspaceRoots: [],
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: options.baseInstructions
  };
}

export function buildSafeTurnStartParams(options: {
  threadId: string;
  model: string;
  effort?: string;
  input: string;
  outputSchema?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    threadId: options.threadId,
    input: [{ type: "text", text: options.input }],
    environments: [],
    runtimeWorkspaceRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalPolicy: "never",
    model: options.model,
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {})
  };
}

function buildClientOptions(options: SafeAppServerTurnOptions, onNotification: (notification: AppServerNotification) => void): AppServerClientOptions {
  return {
    requestTimeoutMs: Math.max(30_000, options.timeoutMs),
    onNotification,
    onCrash: options.onCrash,
    onServerRequest: async (request: AppServerServerRequest) => {
      if (request.method !== "item/tool/call" || !options.onDynamicTool || !isRecord(request.params)) {
        throw new Error(`Rejected App Server capability request: ${request.method}`);
      }
      const params = request.params;
      const callId = asString(params.callId);
      const threadId = asString(params.threadId);
      const tool = asString(params.tool);
      const turnId = asString(params.turnId);
      if (!callId || !threadId || !tool || !turnId) {
        throw new Error("Malformed App Server dynamic tool request");
      }
      return options.onDynamicTool({
        callId,
        namespace: typeof params.namespace === "string" ? params.namespace : null,
        threadId,
        tool,
        arguments: params.arguments,
        turnId
      });
    }
  };
}

export async function runSafeAppServerTurn(options: SafeAppServerTurnOptions): Promise<SafeAppServerTurnResult> {
  const startedAt = Date.now();
  const clientFactory = options.clientFactory ?? ((clientOptions) => new DefaultCodexAppServerClient(clientOptions));
  let resolveCompletion!: (result: SafeAppServerTurnResult) => void;
  const completion = new Promise<SafeAppServerTurnResult>((resolve) => {
    resolveCompletion = resolve;
  });
  let threadId: string | undefined;
  let turnId: string | undefined;
  let content = "";
  let usage: LlmUsage | undefined;
  let settled = false;
  let client: AppServerTurnClient | undefined;

  const complete = (result: Omit<SafeAppServerTurnResult, "elapsedMs">): void => {
    if (settled) return;
    settled = true;
    resolveCompletion({ ...result, elapsedMs: Date.now() - startedAt });
  };

  const onNotification = (notification: AppServerNotification): void => {
    options.onNotification?.(notification);
    if (notification.method === "item/agentMessage/delta" && isRecord(notification.params)) {
      content += typeof notification.params.delta === "string" ? notification.params.delta : "";
    }
    if (notification.method === "turn/started" && isRecord(notification.params)) {
      const startedTurn = extractId(notification.params, "turn");
      if (startedTurn) turnId = startedTurn;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      usage = mapUsage(notification.params) ?? usage;
    }
    if (notification.method === "turn/completed" && isRecord(notification.params)) {
      const completedTurn = isRecord(notification.params.turn) ? notification.params.turn : {};
      const status = asString(completedTurn.status);
      const error = isRecord(completedTurn.error) ? completedTurn.error : undefined;
      if (status === "completed") {
        complete({ status, content, usage, threadId, turnId });
      } else if (status === "interrupted") {
        complete({ status, content, usage, threadId, turnId, error: "Codex turn interrupted" });
      } else {
        complete({ status: "failed", content, usage, threadId, turnId, error: safeError(error?.message ?? "Codex turn failed") });
      }
    }
  };

  try {
    client = clientFactory(buildClientOptions({
      ...options,
      onCrash: (error) => {
        options.onCrash?.(error);
        complete({ status: "failed", content, usage, threadId, turnId, error: safeError(error) });
      }
    }, onNotification));
    await client.initialize({
      clientInfo: { name: "alfred", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });

    const threadResponse = await client.request<Record<string, unknown>>(
      "thread/start",
      buildSafeThreadStartParams({ model: options.model, baseInstructions: options.baseInstructions, dynamicTools: options.dynamicTools }),
      { signal: options.signal }
    );
    threadId = extractId(threadResponse, "thread");
    if (!threadId) throw new Error("Codex App Server did not return a thread id");

    if (options.history && options.history.length > 0) {
      await client.request("thread/inject_items", { threadId, items: options.history }, { signal: options.signal });
    }

    const turnResponse = await client.request<Record<string, unknown>>(
      "turn/start",
      buildSafeTurnStartParams({ threadId, model: options.model, effort: options.effort, input: options.input, outputSchema: options.outputSchema }),
      { signal: options.signal }
    );
    turnId = extractId(turnResponse, "turn") ?? turnId;
    if (!turnId) throw new Error("Codex App Server did not return a turn id");

    let timeoutTimer: NodeJS.Timeout | undefined;
    const abortPromise = new Promise<SafeAppServerTurnResult>((resolve) => {
      if (!options.signal) return;
      const onAbort = () => resolve({ status: "interrupted", content, usage, threadId, turnId, error: "Codex turn cancelled", elapsedMs: Date.now() - startedAt });
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timeoutPromise = new Promise<SafeAppServerTurnResult>((resolve) => {
      timeoutTimer = setTimeout(() => resolve({ status: "timeout", content, usage, threadId, turnId, error: `Codex turn timed out after ${options.timeoutMs}ms`, elapsedMs: Date.now() - startedAt }), options.timeoutMs);
      timeoutTimer.unref?.();
    });

    const result = await Promise.race([completion, abortPromise, timeoutPromise]);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if ((result.status === "interrupted" || result.status === "timeout") && client && threadId && turnId) {
      await client.interruptTurn(threadId, turnId, { timeoutMs: 2_000 }).catch(() => undefined);
    }
    return result;
  } catch (error) {
    return {
      status: "failed",
      content,
      usage,
      threadId,
      turnId,
      error: safeError(error),
      elapsedMs: Date.now() - startedAt
    };
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}

export type SupervisedAppServerClient = CodexAppServerClient;
