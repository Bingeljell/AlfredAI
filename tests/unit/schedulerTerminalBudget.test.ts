import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../../src/runtime/agentLoop.js";
import { createSchedulerTurnControl } from "../../src/scheduler/execution.js";
import { setActiveLlmProvider, resetActiveLlmProvider } from "../../src/provider/registry.js";
import type {
  LlmProvider,
  LlmStructuredRequest,
  LlmStructuredResult,
  LlmTextRequest,
  LlmTextResult,
  LlmToolCallRequest,
  LlmToolCallResult,
} from "../../src/provider/types.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

const TASK_ID = "550e8400-e29b-41d4-a716-446655440000";
const CYCLE_ID = `${TASK_ID}:1`;

abstract class SchedulerProviderBase implements LlmProvider {
  readonly name = "scheduler-test";

  abstract generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult>;

  async generateText(_request: LlmTextRequest): Promise<LlmTextResult> {
    throw new Error("not used");
  }

  async generateStructured<T>(_request: LlmStructuredRequest, _validator: never): Promise<LlmStructuredResult<T>> {
    throw new Error("not used");
  }
}

class WanderingProvider extends SchedulerProviderBase {
  requests = 0;

  async generateWithTools(_request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    this.requests += 1;
    return {
      provider: this.name,
      finishReason: "tool_calls",
      toolCalls: [{
        id: `probe-${this.requests}`,
        name: "file_exists",
        arguments: JSON.stringify({ relativePath: "missing-result.txt" }),
      }],
    };
  }
}

class TerminalFirstProvider extends SchedulerProviderBase {
  requests = 0;

  async generateWithTools(_request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    this.requests += 1;
    if (this.requests < 5) {
      return {
        provider: this.name,
        finishReason: "tool_calls",
        toolCalls: [{
          id: `probe-${this.requests}`,
          name: "file_exists",
          arguments: JSON.stringify({ relativePath: "missing-result.txt" }),
        }],
      };
    }
    return {
      provider: this.name,
      finishReason: "tool_calls",
      toolCalls: [{
        id: "terminal-5",
        name: "scheduler_task_complete",
        arguments: JSON.stringify({ taskId: TASK_ID, cycleId: CYCLE_ID, summary: "Observed the bounded result." }),
      }],
    };
  }
}

async function runSchedulerLoop(provider: LlmProvider) {
  const workspace = await createTempWorkspace("scheduler-terminal-budget");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Check the task", "running");
  const control = createSchedulerTurnControl(TASK_ID, CYCLE_ID);
  setActiveLlmProvider(provider);
  try {
    const outcome = await runAgentLoop({
      runId: run.runId,
      sessionId: "session-1",
      message: "Check the task",
      model: "scheduler-test-model",
      systemPrompt: "You are a bounded scheduler worker.",
      toolAllowlist: ["file_exists", "scheduler_task_complete", "scheduler_task_reschedule"],
      maxIterations: 5,
      maxDurationMs: 60_000,
      maxToolCalls: 5,
      runStore,
      searchManager: {} as never,
      workspaceDir: workspace,
      defaults: { searchMaxResults: 10, browseConcurrency: 1 },
      policyMode: "trusted",
      isCancellationRequested: async () => false,
      executionProfile: {
        origin: "scheduler",
        maxIterations: 5,
        maxToolCalls: 5,
        maxDurationMs: 60_000,
        toolAllowlist: ["file_exists", "scheduler_task_complete", "scheduler_task_reschedule"],
        persistConversation: false,
        taskId: TASK_ID,
        cycleId: CYCLE_ID,
      },
      schedulerControl: control,
    });
    return { outcome, control, runStore, runId: run.runId };
  } finally {
    resetActiveLlmProvider();
  }
}

test("scheduler wake forces a bounded reschedule instead of failing at the tool limit", async () => {
  const provider = new WanderingProvider();
  const result = await runSchedulerLoop(provider);

  assert.equal(provider.requests, 5);
  assert.equal(result.control.action?.type, "reschedule");
  assert.equal(result.outcome.status, "completed");
  assert.match(result.outcome.assistantText ?? "", /exhausted its observation budget/);
  assert.match(result.outcome.assistantText ?? "", /Partial result/);

  const run = await result.runStore.getRun(result.runId);
  assert.equal(run?.toolCalls.length, 4);
  const events = run ? await result.runStore.listRunEvents(run) : [];
  assert.ok(events.some((event) => event.eventType === "scheduler_terminal_action_forced"));
});

test("scheduler wake gives the terminal action the final reserved tool slot", async () => {
  const provider = new TerminalFirstProvider();
  const result = await runSchedulerLoop(provider);

  assert.equal(provider.requests, 5);
  assert.deepEqual(result.control.action, { type: "complete", summary: "Observed the bounded result." });
  assert.equal(result.outcome.status, "completed");
  assert.match(result.outcome.assistantText ?? "", /Observed the bounded result/);

  const run = await result.runStore.getRun(result.runId);
  assert.deepEqual(run?.toolCalls.map((call) => call.toolName), [
    "file_exists",
    "file_exists",
    "file_exists",
    "file_exists",
    "scheduler_task_complete",
  ]);
});
