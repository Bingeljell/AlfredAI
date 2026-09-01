import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  AppServerClientClosedError,
  AppServerRpcError,
  CodexAppServerClient,
  type AppServerServerRequest
} from "../../src/provider/codex/appServerClient.js";

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  writes: string[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk) => this.writes.push(String(chunk)));
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  respond(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  emitClose(): void {
    this.emit("close", 1, null);
  }
}

function fakeClient(
  handler?: (process: FakeProcess, method: string, params: unknown) => void,
  clientOptions: { onNotification?: (notification: { method: string; params?: unknown }) => void; onServerRequest?: (request: AppServerServerRequest) => Promise<unknown> | unknown } = {}
) {
  let process: FakeProcess;
  const client = new CodexAppServerClient({
    requestTimeoutMs: 100,
    ...clientOptions,
    spawnImpl: () => {
      process = new FakeProcess();
      process.stdin.on("data", (chunk) => {
        const request = JSON.parse(String(chunk).trim()) as { id: number; method: string; params: unknown };
        handler?.(process, request.method, request.params);
      });
      return process as never;
    }
  });
  return { client, get process() { return process!; } };
}

test("App Server client correlates out-of-order RPC responses and forwards notifications", async () => {
  const notifications: string[] = [];
  const clientWithNotifications = fakeClient((child, method) => {
    if (method === "initialize") child.respond({ id: 1, result: { userAgent: "test" } });
    if (method === "model/list") setTimeout(() => child.respond({ id: 3, result: { data: ["slow"] } }), 5);
    if (method === "thread/start") setTimeout(() => child.respond({ id: 2, result: { thread: { id: "thread-1" } } }), 15);
  }, { onNotification: (notification) => notifications.push(notification.method) });
  const notifiedClient = clientWithNotifications.client;

  const init = await notifiedClient.initialize({ clientInfo: { name: "test", version: "1" } });
  assert.deepEqual(init, { userAgent: "test" });
  const threadPromise = notifiedClient.request("thread/start", {});
  const modelPromise = notifiedClient.request("model/list", {});
  clientWithNotifications.process.respond({ method: "thread/status/changed", params: {} });
  assert.deepEqual(await modelPromise, { data: ["slow"] });
  assert.deepEqual(await threadPromise, { thread: { id: "thread-1" } });
  assert.deepEqual(notifications, ["thread/status/changed"]);
  await notifiedClient.close();
});

test("App Server client routes dynamic server requests and rejects unhandled requests without throwing", async () => {
  const seen: AppServerServerRequest[] = [];
  const { client, process } = fakeClient((child, method) => {
    if (method === "initialize") child.respond({ id: 1, result: {} });
  });
  const clientWithHandler = fakeClient((child, method) => {
    if (method === "initialize") child.respond({ id: 1, result: {} });
  }, { onServerRequest: async (request) => {
    seen.push(request);
    if (request.method === "item/tool/call") return { success: true, contentItems: [] };
    throw new Error("policy denied");
  } });
  await clientWithHandler.client.initialize({ clientInfo: { name: "test", version: "1" } });
  clientWithHandler.process.respond({ id: "dynamic-1", method: "item/tool/call", params: { tool: "alfred" } });
  clientWithHandler.process.respond({ id: "builtin-1", method: "item/commandExecution/requestApproval", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const responses = clientWithHandler.process.writes.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(seen.map((request) => request.method), ["item/tool/call", "item/commandExecution/requestApproval"]);
  assert.equal(responses[0]?.result && (responses[0].result as Record<string, unknown>).success, true);
  assert.equal((responses[1]?.error as Record<string, unknown>).message, "policy denied");
  await clientWithHandler.client.close();
});

test("App Server client rejects pending requests on crash and supports abort", async () => {
  const crashedClient = fakeClient();
  const pending = crashedClient.client.request("thread/start", {});
  crashedClient.process.emitClose();
  await assert.rejects(pending, /Codex App Server exited/);

  const abortController = new AbortController();
  const aborted = fakeClient();
  const request = aborted.client.request("thread/start", {}, { signal: abortController.signal });
  abortController.abort();
  await assert.rejects(request, AppServerClientClosedError);
  await aborted.client.close();
  await assert.rejects(aborted.client.request("thread/start", {}), AppServerClientClosedError);
  assert.notEqual(new AppServerRpcError("x", -1, "bad").message, "bad");
});
