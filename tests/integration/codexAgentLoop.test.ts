import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../src/runs/runStore.js";
import { setActiveLlmProvider, resetActiveLlmProvider } from "../../src/provider/registry.js";
import type { LlmProvider, LlmStructuredRequest, LlmStructuredResult, LlmTextRequest, LlmTextResult, LlmToolCallRequest, LlmToolCallResult } from "../../src/provider/types.js";
import { runAgentLoop } from "../../src/runtime/agentLoop.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class MockCodexProvider implements LlmProvider {
  readonly name = "codex";
  readonly requests: LlmToolCallRequest[] = [];

  async generateText(_request: LlmTextRequest): Promise<LlmTextResult> { throw new Error("not used"); }
  async generateStructured<T>(_request: LlmStructuredRequest, _validator: never): Promise<LlmStructuredResult<T>> { throw new Error("not used"); }

  async generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 1) {
      assert.equal(request.messages.some((message) => message.role === "system"), true);
      assert.equal(request.tools.some((tool) => tool.name === "file_list"), true);
      return {
        provider: this.name,
        toolCalls: [{ id: "call-1", name: "file_list", arguments: "{\"path\":\".\",\"limit\":1}" }],
        finishReason: "tool_calls",
        providerState: {
          provider: "codex",
          data: { outputItems: [{ type: "reasoning", encrypted_content: "continuation-canary" }, { type: "function_call", call_id: "call-1", name: "file_list", arguments: "{\"path\":\".\",\"limit\":1}" }] }
        }
      };
    }
    const assistant = request.messages.find((message) => message.role === "assistant");
    assert.equal(assistant?.providerState?.provider, "codex");
    assert.equal(JSON.stringify(assistant?.providerState).includes("continuation-canary"), true);
    assert.equal(request.messages.some((message) => message.role === "tool" && message.toolCallId === "call-1"), true);
    return { provider: this.name, content: "done", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
  }
}

test("Codex tool round trips through Alfred's existing agent loop", async () => {
  const workspace = await createTempWorkspace("alfred-codex-loop");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "list files", "running");
  const provider = new MockCodexProvider();
  setActiveLlmProvider(provider);
  try {
    const outcome = await runAgentLoop({
      runId: run.runId,
      sessionId: "session-1",
      message: "list files",
      model: "codex-mini",
      systemPrompt: "You are Alfred.",
      toolAllowlist: ["file_list"],
      maxIterations: 3,
      maxDurationMs: 60_000,
      runStore,
      searchManager: {} as never,
      workspaceDir: workspace,
      defaults: { searchMaxResults: 15, browseConcurrency: 3 },
      policyMode: "trusted",
      isCancellationRequested: async () => false
    });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.assistantText, "done");
    assert.equal(provider.requests.length, 2);
    const debug = JSON.stringify(await runStore.buildDebugExport(run.runId));
    assert.equal(debug.includes("continuation-canary"), false);
  } finally {
    resetActiveLlmProvider();
  }
});
