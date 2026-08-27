import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../../src/runtime/agentLoop.js";
import { resetActiveLlmProvider, setActiveLlmProvider } from "../../src/provider/registry.js";
import type {
  LlmProvider,
  LlmStructuredRequest,
  LlmStructuredResult,
  LlmTextRequest,
  LlmTextResult,
  LlmToolCallRequest,
  LlmToolCallResult
} from "../../src/provider/types.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class GroundingProvider implements LlmProvider {
  readonly name = "grounding-test";
  readonly requests: LlmToolCallRequest[] = [];

  constructor(private readonly replies: string[]) {}

  async generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    this.requests.push(request);
    return {
      provider: this.name,
      content: this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)],
      finishReason: "stop"
    };
  }

  async generateText(_request: LlmTextRequest): Promise<LlmTextResult> {
    throw new Error("not used");
  }

  async generateStructured<T>(_request: LlmStructuredRequest, _validator: never): Promise<LlmStructuredResult<T>> {
    throw new Error("not used");
  }
}

async function runGroundingLoop(provider: LlmProvider) {
  const workspace = await createTempWorkspace("grounding-agent-loop");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-grounding", "Find current news", "running");
  setActiveLlmProvider(provider);
  try {
    const outcome = await runAgentLoop({
      runId: run.runId,
      sessionId: "session-grounding",
      message: "Find current news",
      model: "grounding-test-model",
      systemPrompt: "Use tools and report honestly.",
      toolAllowlist: [],
      maxIterations: 3,
      maxDurationMs: 60_000,
      runStore,
      searchManager: {} as never,
      workspaceDir: workspace,
      defaults: { searchMaxResults: 10, browseConcurrency: 1 },
      policyMode: "trusted",
      isCancellationRequested: async () => false
    });
    const storedRun = await runStore.getRun(run.runId);
    const events = storedRun ? await runStore.listRunEvents(storedRun) : [];
    return { outcome, events };
  } finally {
    resetActiveLlmProvider();
  }
}

test("agent loop intercepts an unsupported action claim and requests a repair", async () => {
  const provider = new GroundingProvider([
    "Done — straight from SearXNG. Here are the results.",
    "I could not access search in this run, so I do not have verified results to share."
  ]);

  const { outcome, events } = await runGroundingLoop(provider);

  assert.equal(provider.requests.length, 2);
  assert.equal(outcome.status, "completed");
  assert.match(outcome.assistantText ?? "", /could not access search/);
  assert.ok(provider.requests[1]?.messages.some((message) =>
    message.role === "system" && message.content.includes("Grounding correction")
  ));
  assert.ok(events.some((event) => event.eventType === "grounding_violation"));
});

test("agent loop replaces a repeated unsupported claim with a deterministic correction", async () => {
  const provider = new GroundingProvider([
    "I searched SearXNG and found the answer.",
    "I searched again and verified the answer."
  ]);

  const { outcome } = await runGroundingLoop(provider);

  assert.equal(provider.requests.length, 2);
  assert.equal(outcome.status, "completed");
  assert.match(outcome.assistantText ?? "", /did not successfully perform/);
  assert.doesNotMatch(outcome.assistantText ?? "", /found the answer/);
});
