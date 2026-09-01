import test from "node:test";
import assert from "node:assert/strict";
import type { AppServerClientOptions, AppServerServerRequest } from "../../src/provider/codex/appServerClient.js";
import type { AppServerTurnClient } from "../../src/provider/codex/appServerTurn.js";
import { CodexAppServerRuntime } from "../../src/runtime/codexAppServerRuntime.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class FakeAppServerClient implements AppServerTurnClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly options: AppServerClientOptions) {}
  async initialize(): Promise<Record<string, unknown>> { return {}; }
  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1", ephemeral: true } } as T;
    if (method === "turn/start") {
      queueMicrotask(async () => {
        const call: AppServerServerRequest = {
          id: "server-call-1",
          method: "item/tool/call",
          params: { callId: "call-1", namespace: null, threadId: "thread-1", tool: "file_exists", arguments: { relativePath: "missing.md" }, turnId: "turn-1" }
        };
        await this.options.onServerRequest?.(call);
        this.options.onNotification?.({ method: "item/agentMessage/delta", params: { delta: "done" } });
        this.options.onNotification?.({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      });
      return { turn: { id: "turn-1" } } as T;
    }
    return {} as T;
  }
  async interruptTurn(): Promise<void> {}
  async close(): Promise<void> {}
}

test("Codex App Server runtime injects Alfred context and dispatches dynamic tools safely", async () => {
  const workspace = await createTempWorkspace("alfred-codex-runtime");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "check", "running");
  let client: FakeAppServerClient | undefined;
  const runtime = new CodexAppServerRuntime({
    runStore,
    searchManager: {} as never,
    workspaceDir: workspace,
    searchMaxResults: 15,
    fastScrapeCount: 5,
    enablePlaywright: false,
    maxSteps: 6,
    browseConcurrency: 3,
    agentMaxDurationMs: 60_000,
    agentMaxToolCalls: 4,
    agentMaxParallelTools: 2,
    defaultModel: "gpt-live",
    policyMode: "trusted",
    subscriptionService: { listModels: async () => [{ id: "gpt-live", model: "gpt-live", displayName: "Live", description: "", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }], inputModalities: ["text"] }] } as never,
    clientFactory: (options) => {
      client = new FakeAppServerClient(options);
      return client;
    }
  });

  const result = await runtime.runTurn({
    runId: run.runId,
    sessionId: "session-1",
    message: "check this now",
    executionProfile: {
      origin: "interactive",
      maxIterations: 2,
      maxToolCalls: 4,
      maxDurationMs: 60_000,
      toolAllowlist: ["file_exists"],
      persistConversation: true
    },
    sessionContext: { conversationWindow: [{ role: "user", content: "previous", runId: "old", timestamp: "now" }, { role: "assistant", content: "old answer", runId: "old", timestamp: "now" }] }
  });

  assert.deepEqual(result, { status: "completed", assistantText: "done", artifactPaths: undefined });
  assert.ok(client);
  assert.deepEqual(client.requests.map((request) => request.method), ["thread/start", "thread/inject_items", "turn/start"]);
  const thread = client.requests[0]?.params as Record<string, unknown>;
  assert.equal(thread.ephemeral, true);
  assert.deepEqual(thread.environments, []);
  assert.deepEqual(thread.runtimeWorkspaceRoots, []);
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.equal((thread.dynamicTools as Array<{ name: string }>).some((tool) => tool.name === "file_exists"), true);
  const injected = client.requests[1]?.params as { items: Array<{ content: Array<{ text: string }> }> };
  assert.deepEqual(injected.items.map((item) => item.content[0]?.text), ["previous", "old answer"]);
  const turn = client.requests[2]?.params as Record<string, unknown>;
  assert.deepEqual(turn.input, [{ type: "text", text: "check this now" }]);
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual(turn.environments, []);
  assert.deepEqual(turn.runtimeWorkspaceRoots, []);
  const persisted = await runStore.getRun(run.runId);
  assert.equal(persisted?.toolCalls.length, 1);
  assert.equal(persisted?.toolCalls[0]?.toolName, "file_exists");
});
