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

test("runAlfredOrchestratorLoop records delegation telemetry and passes scratchpad to delegated agent", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-delegate");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Find leads", "running");

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Delegate to the lead specialist.",
          actionType: "delegate_agent" as const,
          delegateAgent: "lead_agent",
          delegateBrief: "Find 3 leads with emails",
          toolName: null,
          toolInputJson: null,
          responseText: null
        },
        usage: {
          promptTokens: 90,
          completionTokens: 18,
          totalTokens: 108
        }
      } as StructuredChatDiagnostic<T>;
    }

    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "The delegated result is sufficient to answer the turn.",
          shouldRespond: true,
          responseText: "Delegated result accepted.",
          continueReason: null,
          confidence: 0.87
        },
        usage: {
          promptTokens: 70,
          completionTokens: 14,
          totalTokens: 84
        }
      } as StructuredChatDiagnostic<T>;
    }

    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  let delegatedInput: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["agentLoopRunner"]> extends (
    options: infer TOptions
  ) => Promise<unknown>
    ? TOptions | undefined
    : never;
  const agentLoopRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["agentLoopRunner"]> = async (options) => {
    delegatedInput = options;
    return {
      status: "completed",
      assistantText: "Lead agent found 3 leads.",
      artifactPaths: ["/tmp/fake-leads.csv"]
    };
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Find 3 leads with emails",
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
      throw new Error("lead pipeline should not run in delegated telemetry test");
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
    structuredChatRunner,
    agentLoopRunner
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Delegated result accepted.");
  assert.equal(delegatedInput?.skillName, "lead_agent");
  assert.equal(delegatedInput?.parentRunId, run.runId);
  assert.equal(delegatedInput?.delegationId, "delegation_1");
  assert.equal(delegatedInput?.scratchpad?.currentTurnObjective, "Find 3 leads with emails");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const delegatedEvent = events.find((event) => event.eventType === "agent_delegated");
  const resultEvent = events.find((event) => event.eventType === "agent_delegation_result");
  assert.ok(delegatedEvent);
  assert.ok(resultEvent);
  assert.equal(delegatedEvent?.payload.delegationId, "delegation_1");
  assert.equal(resultEvent?.payload.delegationId, "delegation_1");
});
