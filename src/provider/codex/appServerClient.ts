import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type AppServerRequestId = string | number;

export interface AppServerMessage {
  jsonrpc?: "2.0";
  id?: AppServerRequestId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerServerRequest {
  id: AppServerRequestId;
  method: string;
  params?: unknown;
}

export interface AppServerClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnImpl?: (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;
  onNotification?: (notification: AppServerNotification) => void;
  onServerRequest?: (request: AppServerServerRequest) => Promise<unknown> | unknown;
  onCrash?: (error: Error) => void;
}

export interface AppServerInitializeParams {
  clientInfo: {
    name: string;
    version: string;
    title?: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
}

export class AppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown
  ) {
    super(`${method}: ${message}`);
    this.name = "AppServerRpcError";
  }
}

export class AppServerClientClosedError extends Error {
  constructor(message = "Codex App Server client is closed") {
    super(message);
    this.name = "AppServerClientClosedError";
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface AppServerProcess {
  stdin: { write(chunk: string): boolean; end?: () => void };
  stdout: EventEmitter & { setEncoding?(encoding: BufferEncoding): void };
  stderr: EventEmitter & { setEncoding?(encoding: BufferEncoding): void };
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error" | "close", listener: (...args: unknown[]) => void): this;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is AppServerRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export class CodexAppServerClient {
  private readonly options: Required<Pick<AppServerClientOptions, "command" | "args" | "requestTimeoutMs">> & AppServerClientOptions;
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private child: AppServerProcess | undefined;
  private buffer = "";
  private nextRequestId = 1;
  private closed = false;
  private initialized = false;

  constructor(options: AppServerClientOptions = {}) {
    this.options = {
      command: options.command ?? "codex",
      args: options.args ?? ["app-server", "--stdio"],
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ...options
    };
  }

  get isConnected(): boolean {
    return Boolean(this.child) && !this.closed;
  }

  async initialize(params: AppServerInitializeParams): Promise<Record<string, unknown>> {
    this.ensureProcess();
    const result = await this.request<Record<string, unknown>>("initialize", params);
    this.initialized = true;
    return result;
  }

  async request<T>(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    this.ensureProcess();
    if (options.signal?.aborted) throw new AppServerClientClosedError(`App Server request aborted: ${method}`);
    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    const promise = new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          this.removeAbortListener(pending);
          reject(new AppServerRpcError(method, undefined, `timed out after ${timeoutMs}ms`));
        }, timeoutMs),
        signal: options.signal
      };
      if (options.signal) {
        pending.abortListener = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(pending.timer);
          reject(new AppServerClientClosedError(`App Server request aborted: ${method}`));
        };
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
    });

    try {
      this.write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        this.removeAbortListener(pending);
        pending.reject(asError(error, `Failed to send App Server request: ${method}`));
      }
    }
    return promise;
  }

  async interruptTurn(threadId: string, turnId: string, options: { timeoutMs?: number } = {}): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId }, options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    const error = new AppServerClientClosedError();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.removeAbortListener(pending);
      pending.reject(error);
    }
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill("SIGTERM");
  }

  private ensureProcess(): void {
    if (this.closed) throw new AppServerClientClosedError();
    if (this.child) return;

    const spawnImpl = this.options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    const child = spawnImpl(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.setEncoding?.("utf8");
    child.stderr.setEncoding?.("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.consume(String(chunk)));
    child.stderr.on("data", (chunk: string | Buffer) => {
      // stderr is intentionally not forwarded by the client. Callers may
      // attach their own process diagnostics without risking secrets entering
      // Alfred run events or RPC error messages.
      void chunk;
    });
    child.once("error", (error) => this.handleCrash(asError(error, "Codex App Server process error")));
    child.once("close", (code, signal) => {
      if (this.closed) return;
      this.handleCrash(new Error(`Codex App Server exited (code=${String(code)}, signal=${String(signal)})`));
    });
  }

  private write(message: AppServerMessage): void {
    if (!this.child || this.closed) throw new AppServerClientClosedError();
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch {
      this.handleCrash(new Error("Codex App Server emitted malformed JSON"));
      return;
    }

    if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      this.removeAbortListener(pending);
      if (message.error) {
        pending.reject(new AppServerRpcError(pending.method, message.error.code, message.error.message ?? "RPC request failed", message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined && message.id !== null && isRequestId(message.id)) {
      void this.handleServerRequest({ id: message.id, method: message.method, params: message.params });
      return;
    }
    if (message.method) {
      this.options.onNotification?.({ method: message.method, params: message.params });
    }
  }

  private async handleServerRequest(request: AppServerServerRequest): Promise<void> {
    try {
      if (!this.options.onServerRequest) {
        throw new Error(`No handler registered for App Server request: ${request.method}`);
      }
      const result = await this.options.onServerRequest(request);
      this.write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32001, message: asError(error, "App Server request rejected").message }
      });
    }
  }

  private handleCrash(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.child = undefined;
    this.initialized = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.removeAbortListener(pending);
      pending.reject(error);
    }
    this.pending.clear();
    this.options.onCrash?.(error);
  }

  private removeAbortListener(pending: PendingRequest): void {
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
      pending.abortListener = undefined;
    }
  }
}
