import test from "node:test";
import assert from "node:assert/strict";
import { runAlfredOrchestratorLoop } from "../../src/core/runAlfredOrchestratorLoop.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import type { SearchManager } from "../../src/tools/search/searchManager.js";
import type { StructuredChatDiagnostic } from "../../src/services/openAiClient.js";

class FakeSearchManager {
  async search() {
    return {
      provider: "searxng" as const,
      fallbackUsed: false,
      results: []
    };
  }
}

test("runAlfredOrchestratorLoop responds after successful tool when completion evaluator says enough", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Diagnose this run", "running");

  let plannerCalls = 0;
  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    plannerCalls += 1;
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Use diagnostics on the current run before replying.",
          actionType: "call_tool" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: "run_diagnostics",
          toolInputJson: JSON.stringify({ runId: run.runId }),
          responseText: null
        },
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120
        }
      } as StructuredChatDiagnostic<T>;
    }

    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "The diagnostics output already answers the user.",
          shouldRespond: true,
          responseText: "Diagnostics summary ready.",
          continueReason: null,
          confidence: 0.91
        },
        usage: {
          promptTokens: 80,
          completionTokens: 15,
          totalTokens: 95
        }
      } as StructuredChatDiagnostic<T>;
    }

    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Diagnose this run",
    runId: run.runId,
    sessionId: "session-1",
    openAiApiKey: "test-key",
    defaults: {
      searchMaxResults: 15,
      subReactMaxPages: 10,
      subReactBrowseConcurrency: 3,
      subReactBatchSize: 4,
      subReactLlmMaxCalls: 6,
      subReactMinConfidence: 0.6
    },
    leadPipelineExecutor: async () => {
      throw new Error("lead pipeline should not run in this test");
    },
    maxIterations: 4,
    maxDurationMs: 60_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 4,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Diagnostics summary ready.");
  assert.equal(plannerCalls, 2);

  const updatedRun = await runStore.getRun(run.runId);
  assert.ok(updatedRun?.llmUsage);
  assert.equal(updatedRun?.llmUsage?.callCount, 2);
  assert.ok(updatedRun?.toolCalls.some((call) => call.toolName === "run_diagnostics" && call.status === "ok"));

  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "alfred_completion_evaluated"));
});
