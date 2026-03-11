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
    if (options.schemaName === "alfred_lead_execution_brief") {
      return {
        result: {
          thought: "Lead brief not needed for diagnostics.",
          requestedLeadCount: 1,
          emailRequired: false,
          outputFormat: null,
          objectiveBrief: {
            objectiveSummary: "Diagnose the current run.",
            companyType: null,
            industry: null,
            geography: null,
            businessModel: null,
            contactRequirement: "diagnostics requested",
            constraintsMissing: []
          }
        },
        usage: {
          promptTokens: 40,
          completionTokens: 10,
          totalTokens: 50
        }
      } as StructuredChatDiagnostic<T>;
    }

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
    options: { schemaName: string; messages?: Array<{ role: string; content: string }> }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_lead_execution_brief") {
      return {
        result: {
          thought: "Preserve the user's exact request for the lead specialist.",
          requestedLeadCount: 3,
          emailRequired: true,
          outputFormat: null,
          objectiveBrief: {
            objectiveSummary: "Find 3 leads with emails.",
            companyType: null,
            industry: null,
            geography: null,
            businessModel: null,
            contactRequirement: "email required",
            constraintsMissing: []
          }
        },
        usage: {
          promptTokens: 50,
          completionTokens: 12,
          totalTokens: 62
        }
      } as StructuredChatDiagnostic<T>;
    }

    if (options.schemaName === "alfred_orchestrator_plan") {
      const plannerInput = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
        objectiveContract?: { requiredDeliverable?: string; doneCriteria?: string[] };
        turnState?: { turnObjective?: string; completionCriteria?: string[]; missingRequirements?: string[] };
      };
      assert.ok(plannerInput.objectiveContract);
      assert.ok(typeof plannerInput.objectiveContract?.requiredDeliverable === "string");
      assert.ok(Array.isArray(plannerInput.objectiveContract?.doneCriteria));
      assert.equal(plannerInput.turnState?.turnObjective, "Find 3 leads with emails");
      assert.ok(Array.isArray(plannerInput.turnState?.completionCriteria));
      assert.ok(Array.isArray(plannerInput.turnState?.missingRequirements));
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
  assert.deepEqual(outcome.artifactPaths, ["/tmp/fake-leads.csv"]);
  assert.equal(delegatedInput?.skillName, "lead_agent");
  assert.equal(delegatedInput?.parentRunId, run.runId);
  assert.equal(delegatedInput?.delegationId, "delegation_1");
  assert.equal(delegatedInput?.scratchpad?.currentTurnObjective, "Find 3 leads with emails");
  assert.equal(delegatedInput?.leadExecutionBrief?.requestedLeadCount, 3);
  assert.equal(delegatedInput?.leadExecutionBrief?.emailRequired, true);
  assert.equal(delegatedInput?.leadExecutionBrief?.objectiveBrief.contactRequirement, "email required");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const delegatedEvent = events.find((event) => event.eventType === "agent_delegated");
  const resultEvent = events.find((event) => event.eventType === "agent_delegation_result");
  const turnStateEvent = events.find((event) => event.eventType === "alfred_turn_state_updated");
  const contractEvent = events.find((event) => event.eventType === "alfred_objective_contract_created");
  assert.ok(delegatedEvent);
  assert.ok(resultEvent);
  assert.ok(turnStateEvent);
  assert.ok(contractEvent);
  assert.equal(delegatedEvent?.payload.delegationId, "delegation_1");
  assert.equal(resultEvent?.payload.delegationId, "delegation_1");
  assert.equal((delegatedEvent?.payload as { leadExecutionBrief?: { requestedLeadCount?: number } } | undefined)?.leadExecutionBrief?.requestedLeadCount, 3);
});

test("runAlfredOrchestratorLoop avoids clarification-only first response for executable lead request", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-clarification-guardrail");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Find 12 leads", "running");

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_lead_execution_brief") {
      return {
        result: {
          thought: "Build brief from user turn.",
          requestedLeadCount: 12,
          emailRequired: true,
          outputFormat: "csv",
          objectiveBrief: {
            objectiveSummary: "Find 12 MSP leads in USA with emails.",
            companyType: "MSP/SI",
            industry: null,
            geography: "USA",
            businessModel: null,
            contactRequirement: "email required",
            constraintsMissing: []
          }
        },
        usage: {
          promptTokens: 40,
          completionTokens: 10,
          totalTokens: 50
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Need clarifications first.",
          actionType: "respond" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Please clarify exclusions."
        },
        usage: {
          promptTokens: 60,
          completionTokens: 20,
          totalTokens: 80
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "Delegated output is enough.",
          shouldRespond: true,
          responseText: "Executed.",
          continueReason: null,
          confidence: 0.8
        },
        usage: {
          promptTokens: 30,
          completionTokens: 10,
          totalTokens: 40
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  let delegated = false;
  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Find me 12 MSP leads with emails in USA",
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
      throw new Error("lead pipeline should not run in clarification guardrail test");
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
    agentLoopRunner: async () => {
      delegated = true;
      return {
        status: "completed",
        assistantText: "Lead run done.",
        artifactPaths: ["/tmp/guardrail.csv"]
      };
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(delegated, true);
  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "alfred_plan_adjusted"));
});

test("runAlfredOrchestratorLoop answers diagnostic turns from run evidence without delegating", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-diagnostic-turn");
  const runStore = new RunStore(workspace);
  const previousRun = await runStore.createRun("session-1", "Find 20 leads in Texas", "completed");
  await runStore.addToolCall(previousRun.runId, {
    toolName: "lead_pipeline",
    inputRedacted: { maxPages: 8 },
    outputRedacted: {
      finalCandidateCount: 0,
      requestedLeadCount: 20
    },
    durationMs: 63_000,
    status: "ok",
    timestamp: new Date().toISOString()
  });
  await runStore.updateRun(previousRun.runId, {
    status: "completed",
    assistantText: "Leads collected: 0/20. Stop: budget_exhausted.",
    artifactPaths: ["/tmp/prev-leads.csv"],
    llmUsage: {
      promptTokens: 3000,
      completionTokens: 800,
      totalTokens: 3800,
      callCount: 5
    }
  });
  await runStore.appendEvent({
    runId: previousRun.runId,
    sessionId: "session-1",
    phase: "final",
    eventType: "agent_stop",
    payload: {
      reason: "budget_exhausted"
    },
    timestamp: new Date().toISOString()
  });
  await runStore.appendEvent({
    runId: previousRun.runId,
    sessionId: "session-1",
    phase: "final",
    eventType: "final_answer",
    payload: {
      candidateCount: 0,
      requestedLeadCount: 20
    },
    timestamp: new Date().toISOString()
  });

  const run = await runStore.createRun(
    "session-1",
    "Why did you waste so many tokens and tool calls?",
    "running"
  );

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Why did you waste so many tokens and tool calls?",
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
      throw new Error("lead pipeline should not run for diagnostic turn");
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
    structuredChatRunner: async () => {
      throw new Error("planner should not run for diagnostic turn");
    },
    agentLoopRunner: async () => {
      throw new Error("delegation should not run for diagnostic turn");
    },
    sessionContext: {
      lastCompletedRun: {
        runId: previousRun.runId
      }
    }
  });

  assert.equal(outcome.status, "completed");
  assert.ok((outcome.assistantText ?? "").includes(`Run diagnosis for ${previousRun.runId}:`));
  assert.ok((outcome.assistantText ?? "").includes("Stop reason: budget_exhausted"));
  assert.deepEqual(outcome.artifactPaths, ["/tmp/prev-leads.csv"]);

  const updatedRun = await runStore.getRun(run.runId);
  assert.equal(updatedRun?.toolCalls.length, 0);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "alfred_turn_mode_selected"));
  assert.ok(events.some((event) => event.eventType === "alfred_diagnostic_response"));
});

test("runAlfredOrchestratorLoop stops with policy_block when planner is unauthorized", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-policy-block");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Find 5 leads", "running");

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Find 5 leads",
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
      throw new Error("lead pipeline should not execute on policy block");
    },
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: async () => ({
      failureCode: "http_error",
      failureClass: "policy_block",
      failureMessage: "OpenAI returned status 401",
      statusCode: 401
    })
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.assistantText ?? "", /blocked by policy\/auth/i);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "alfred_planner_failed"));
});
