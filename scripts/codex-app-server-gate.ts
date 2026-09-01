import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  buildCapabilityGateThreadParams,
  buildCapabilityGateTurnParams,
  classifyCapabilityGateServerRequest,
  validateGateDynamicToolCall,
  CODEX_APP_SERVER_GATE_TOOL,
  CODEX_APP_SERVER_GATE_VALUE
} from "../src/provider/codex/appServerGate.js";

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface GateResult {
  dynamicToolCalls: number;
  rejectedCalls: string[];
  unexpectedRequests: string[];
  assistantText: string;
  threadId: string;
  turnStatus: string | undefined;
  effectiveThreadConfig: Record<string, unknown>;
}

const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_APP_SERVER_GATE_TIMEOUT_MS ?? 120_000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNestedString(value: unknown, key: string): string | undefined {
  return isRecord(value) ? getString(value[key]) : undefined;
}

class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly messages: JsonRpcMessage[] = [];
  private nextId = 1;
  private buffer = "";
  private readonly onMessage: (message: JsonRpcMessage) => void;

  constructor(onMessage: (message: JsonRpcMessage) => void) {
    this.onMessage = onMessage;
    this.child = spawn("codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => process.stderr.write(`[codex-app-server] ${chunk}`));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code, signal) => {
      this.rejectAll(new Error(`Codex App Server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  async request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${message}\n`);
    return response;
  }

  respond(id: string | number | null, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id: string | number | null, message: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message } })}\n`);
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    if (!this.child.killed) this.child.kill("SIGTERM");
    await once(this.child, "close").catch(() => undefined);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcMessage;
          this.messages.push(message);
          this.resolveOrNotify(message);
        } catch {
          process.stderr.write(`[codex-app-server] ignored non-JSON stdout: ${line}\n`);
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private resolveOrNotify(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }
    this.onMessage(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function assertRpcSuccess(message: JsonRpcMessage, method: string): Record<string, unknown> {
  if (message.error) throw new Error(`${method} failed: ${message.error.message ?? "unknown error"}`);
  if (!isRecord(message.result)) throw new Error(`${method} returned no result`);
  return message.result;
}

function assertSafeThreadConfig(threadResult: Record<string, unknown>): void {
  const thread = isRecord(threadResult.thread) ? threadResult.thread : undefined;
  const expected: Array<[string, unknown]> = [
    ["thread.ephemeral", thread?.ephemeral],
    ["approvalPolicy", "never"],
    ["sandbox", { type: "readOnly", networkAccess: false }],
    ["runtimeWorkspaceRoots", []]
  ];
  for (const [key, value] of expected) {
    const actual = key.startsWith("thread.") ? thread?.[key.slice("thread.".length)] : threadResult[key];
    if (JSON.stringify(actual) !== JSON.stringify(value)) {
      throw new Error(`unsafe App Server thread configuration: ${key}=${JSON.stringify(actual)}`);
    }
  }
}

async function runGate(): Promise<GateResult> {
  const model = process.env.CODEX_APP_SERVER_GATE_MODEL?.trim() || undefined;
  const rejectedCalls: string[] = [];
  const unexpectedRequests: string[] = [];
  let dynamicToolCalls = 0;
  let assistantText = "";
  let threadId = "";
  let turnStatus: string | undefined;
  let turnCompletedResolve: (() => void) | undefined;
  let turnCompletedReject: ((error: Error) => void) | undefined;
  const turnCompleted = new Promise<void>((resolve, reject) => {
    turnCompletedResolve = resolve;
    turnCompletedReject = reject;
  });

  const rpc = new JsonRpcProcess((message) => {
    const method = message.method;
    if (!method) return;

    // Notifications are server-to-client telemetry and lifecycle events, not
    // requests that can cause an external effect. Only messages with an id
    // enter the capability-request classification below.
    if (message.id === undefined || message.id === null) {
      if (method === "item/agentMessage/delta" && isRecord(message.params)) {
        assistantText += getString(message.params.delta) ?? "";
      }
      if (method === "turn/completed" && isRecord(message.params)) {
        const turn = message.params.turn;
        turnStatus = getNestedString(turn, "status");
        if (turnStatus === "completed" || turnStatus === "interrupted") turnCompletedResolve?.();
        else turnCompletedReject?.(new Error(`turn completed with status ${turnStatus ?? "unknown"}`));
      }
      return;
    }

    const category = classifyCapabilityGateServerRequest(method);
    if (category === "dynamic_tool") {
      if (!isRecord(message.params)) {
        unexpectedRequests.push(`${method}: malformed request envelope`);
        rpc.respondError(message.id, "Malformed dynamic tool request");
        return;
      }
      const params = message.params;
      const validation = validateGateDynamicToolCall({
        callId: getString(params.callId) ?? "",
        namespace: getString(params.namespace) ?? null,
        tool: getString(params.tool) ?? "",
        arguments: params.arguments,
        threadId: getString(params.threadId),
        turnId: getString(params.turnId)
      });
      if (!validation.ok) {
        rejectedCalls.push(validation.reason ?? "invalid dynamic tool call");
        rpc.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: `Rejected by Alfred: ${validation.reason}` }] });
        return;
      }
      dynamicToolCalls += 1;
      rpc.respond(message.id, {
        success: true,
        contentItems: [{ type: "inputText", text: `Alfred executed ${CODEX_APP_SERVER_GATE_TOOL.name}: ${CODEX_APP_SERVER_GATE_VALUE}` }]
      });
      return;
    }

    if (category === "safe_rejection") {
      rejectedCalls.push(method);
      rpc.respondError(message.id, `Rejected by Alfred capability gate: ${method}`);
      return;
    }

    unexpectedRequests.push(method);
    rpc.respondError(message.id, `Unexpected App Server request: ${method}`);
  });

  try {
    const initialize = await rpc.request("initialize", {
      clientInfo: { name: "alfred-capability-gate", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    assertRpcSuccess(initialize, "initialize");

    const thread = assertRpcSuccess(await rpc.request("thread/start", buildCapabilityGateThreadParams(model)), "thread/start");
    assertSafeThreadConfig(thread);
    threadId = getNestedString(thread.thread, "id") ?? "";
    if (!threadId) throw new Error("thread/start returned no thread id");

    const turn = await rpc.request("turn/start", buildCapabilityGateTurnParams(threadId, model));
    assertRpcSuccess(turn, "turn/start");
    await turnCompleted;
    if (dynamicToolCalls !== 1) throw new Error(`expected exactly one Alfred dynamic tool call, received ${dynamicToolCalls}`);
    if (rejectedCalls.length > 0) throw new Error(`unexpected rejected requests during clean gate: ${rejectedCalls.join(", ")}`);
    if (unexpectedRequests.length > 0) throw new Error(`unexpected built-in capability requests: ${unexpectedRequests.join(", ")}`);
    return {
      dynamicToolCalls,
      rejectedCalls,
      unexpectedRequests,
      assistantText,
      threadId,
      turnStatus,
      effectiveThreadConfig: { ephemeral: true, environments: [], runtimeWorkspaceRoots: [], sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "never" }
    };
  } finally {
    await rpc.close();
  }
}

try {
  const result = await runGate();
  console.log(JSON.stringify({
    verdict: "PASS",
    installedCodex: "codex app-server",
    dynamicTool: CODEX_APP_SERVER_GATE_TOOL.name,
    dynamicToolCalls: result.dynamicToolCalls,
    turnStatus: result.turnStatus,
    threadId: result.threadId,
    effectiveThreadConfig: result.effectiveThreadConfig,
    assistantText: result.assistantText.slice(0, 400)
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verdict: "FAIL", error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
