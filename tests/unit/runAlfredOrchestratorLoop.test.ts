import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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

function buildDefaultTurnInterpretation(options: { messages?: Array<{ role: string; content: string }> }) {
  const payload = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
    groundedObjective?: string | null;
    currentMessage?: string | null;
  };
  const groundedObjective = payload.groundedObjective ?? payload.currentMessage ?? "Handle the current turn.";
  const normalized = String(groundedObjective);
  const requiresDraft = /\b(blog|post|article|draft|write)\b/i.test(normalized);
  const requiresCitations = /\b(cite|citation|citations|source|sources)\b/i.test(normalized);
  const targetWordCount = (() => {
    const rangeMatch = normalized.match(/\b(\d{2,4})\s*[-–]\s*(\d{2,4})\s*word/i);
    if (rangeMatch?.[1] && rangeMatch?.[2]) {
      const lower = Number.parseInt(rangeMatch[1], 10);
      const upper = Number.parseInt(rangeMatch[2], 10);
      if (Number.isFinite(lower) && Number.isFinite(upper) && lower > 0 && upper > 0) {
        return Math.round((lower + upper) / 2);
      }
    }
    const singleMatch = normalized.match(/\b(\d{2,4})\s*word/i);
    if (singleMatch?.[1]) {
      const parsed = Number.parseInt(singleMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return null;
  })();
  const requestedOutputPathMatch = normalized.match(/\bworkspace\/\S+/i);
  const requiredDeliverable = requiresDraft
    ? "Deliver the requested blog draft with citations."
    : `Provide a complete response for: ${normalized.slice(0, 180)}`;
  const doneCriteria = [`Answer the current turn directly and honestly: ${normalized.slice(0, 220)}`];
  if (requiresCitations) {
    doneCriteria.push("Include explicit source citations for factual claims.");
  }
  if (requiresDraft) {
    doneCriteria.push("Return the complete draft text in the requested format.");
  }
  return {
    thought: "Interpret the turn directly from the current request.",
    groundedObjective: normalized,
    taskType: "general" as const,
    requiredDeliverable,
    hardConstraints: [],
    doneCriteria,
    assumptions: [],
    requiresDraft,
    requiresCitations,
    targetWordCount,
    requestedOutputPath: requestedOutputPathMatch?.[0] ?? null,
    clarificationNeeded: false,
    clarificationQuestion: null
  };
}

function withDefaultTurnInterpretation(
  handler: (...args: any[]) => Promise<StructuredChatDiagnostic<any>>
) {
  return async <T>(...args: any[]): Promise<StructuredChatDiagnostic<T>> => {
    const options = (args[0] ?? {}) as { schemaName: string; messages?: Array<{ role: string; content: string }> };
    if (options.schemaName === "alfred_turn_interpretation") {
      return {
        result: buildDefaultTurnInterpretation(options)
      } as StructuredChatDiagnostic<T>;
    }
    const diagnostic = await handler(...args);
    if (
      options.schemaName === "alfred_orchestrator_plan" &&
      diagnostic.result &&
      typeof diagnostic.result === "object" &&
      !Array.isArray(diagnostic.result)
    ) {
      const resultRecord = diagnostic.result as Record<string, unknown>;
      if (resultRecord.actionType === "respond" && resultRecord.responseKind == null) {
        resultRecord.responseKind = "final";
      }
    }
    return diagnostic;
  };
}

test("runAlfredOrchestratorLoop does not use deterministic pre-execution clarification gates", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-no-preexecute-clarification-gate");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Research the Middle East war and write me an article", "running");
  let plannerCalled = false;

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Research the Middle East war and write me an article",
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
      throw new Error("lead pipeline should not run in no-preexecute-clarification-gate test");
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
    structuredChatRunner: withDefaultTurnInterpretation(async <T>(options: { schemaName: string; messages?: Array<{ role: string; content: string }> }): Promise<StructuredChatDiagnostic<T>> => {
      plannerCalled = true;
      if (options.schemaName === "alfred_orchestrator_plan") {
        return {
          result: {
            thought: "Proceed directly based on user prompt.",
            actionType: "respond" as const,
            responseKind: "progress" as const,
            delegateAgent: null,
            delegateBrief: null,
            toolName: null,
            toolInputJson: null,
            responseText: "Proceeding with research and drafting."
          }
        } as StructuredChatDiagnostic<T>;
      }
      throw new Error(`unexpected schema request: ${options.schemaName}`);
    })
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Proceeding with research and drafting.");
  assert.equal(plannerCalled, true);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    !events.some(
      (event) =>
        event.eventType === "alfred_clarification_requested" &&
        (event.payload as { source?: string }).source === "pre_execute_gate"
    )
  );
});

test("runAlfredOrchestratorLoop skips clarification gate when user explicitly grants autonomy", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-clarification-bypass");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research the Middle East war and write me an article. You decide the angle.",
    "running"
  );

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Autonomy granted; proceed.",
          actionType: "respond" as const,
          responseKind: "progress" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Proceeding with autonomous angle selection."
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Research the Middle East war and write me an article. You decide the angle.",
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
      throw new Error("lead pipeline should not run in clarification-bypass test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner)
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Proceeding with autonomous angle selection.");
});

test("runAlfredOrchestratorLoop responds after successful tool when completion evaluator says enough", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Retry diagnostics for this run", "running");

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
    message: "Retry diagnostics for this run",
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
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner)
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
    await runStore.addToolCall(run.runId, {
      toolName: "lead_pipeline",
      inputRedacted: { targetLeadCount: 3, includeEmails: true },
      outputRedacted: { finalCandidateCount: 3, emailLeadCount: 3 },
      durationMs: 1200,
      status: "ok",
      timestamp: new Date().toISOString()
    });
    await runStore.updateRun(run.runId, {
      artifactPaths: ["/tmp/fake-leads.csv"]
    });
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
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner),
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

test("runAlfredOrchestratorLoop passes unified taskContract when delegating research_agent", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-research-task-contract");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research latest AI news and write an 800-1000 word article with citations. Save to workspace/alfred/artifacts/blog_test/latest.md. You decide details and proceed.",
    "running"
  );

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Delegate this writing task to research_agent.",
          actionType: "delegate_agent" as const,
          delegateAgent: "research_agent",
          delegateBrief: "Research latest AI news and draft the requested cited article.",
          toolName: null,
          toolInputJson: null,
          responseText: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "Delegated output is sufficient.",
          shouldRespond: true,
          responseText: "Research draft completed.",
          continueReason: null,
          confidence: 0.9
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
      assistantText: "Draft saved.",
      artifactPaths: ["/tmp/latest.md"]
    };
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message:
      "Research latest AI news and write an 800-1000 word article with citations. Save to workspace/alfred/artifacts/blog_test/latest.md. You decide details and proceed.",
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
      throw new Error("lead pipeline should not run in research contract test");
    },
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 3,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner),
    agentLoopRunner
  });

  assert.equal(outcome.status, "completed");
  assert.match(outcome.assistantText ?? "", /research_agent status: completed/i);
  assert.equal(delegatedInput?.skillName, "research_agent");
  assert.equal(delegatedInput?.taskContract?.requiresDraft, true);
  assert.equal(delegatedInput?.taskContract?.requiresCitations, true);
  assert.equal(delegatedInput?.taskContract?.minimumCitationCount, 2);
  assert.equal(
    delegatedInput?.taskContract?.requestedOutputPath,
    "workspace/alfred/artifacts/blog_test/latest.md"
  );
  assert.equal(delegatedInput?.taskContract?.targetWordCount, 900);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const delegatedEvent = events.find((event) => event.eventType === "agent_delegated");
  const delegatedPayload = (delegatedEvent?.payload as { taskContract?: { targetWordCount?: number } } | undefined)
    ?.taskContract;
  assert.ok(delegatedPayload);
  assert.equal(delegatedPayload?.targetWordCount, 900);
});

test("runAlfredOrchestratorLoop treats model interpretation as the semantic source of truth for delegated contract", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-contract-authority");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Write a 900 word article with citations about games for kids. Save to workspace/alfred/artifacts/games.md.",
    "running"
  );

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_turn_interpretation") {
      return {
        result: {
          thought: "The user wants a concise ranked list, not a long-form article.",
          groundedObjective: "Provide a concise ranked list of recent kid-friendly games.",
          taskType: "general" as const,
          requiredDeliverable: "Return a concise ranked list of recent kid-friendly video games.",
          hardConstraints: ["Video games only.", "Maximum 10 items."],
          doneCriteria: ["Return a concise ranked list with up to 10 items.", "Do not widen scope beyond video games."],
          assumptions: ["No board games unless explicitly requested."],
          requiresDraft: false,
          requiresCitations: false,
          targetWordCount: null,
          requestedOutputPath: null,
          clarificationNeeded: false,
          clarificationQuestion: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Delegate to research_agent.",
          actionType: "delegate_agent" as const,
          responseKind: null,
          delegateAgent: "research_agent",
          delegateBrief: "Research and assemble the requested ranked list.",
          toolName: null,
          toolInputJson: null,
          responseText: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "Delegated output is sufficient.",
          shouldRespond: true,
          responseText: "Done.",
          continueReason: null,
          confidence: 0.9
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
      assistantText: "Ranked list completed."
    };
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Write a 900 word article with citations about games for kids. Save to workspace/alfred/artifacts/games.md.",
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
      throw new Error("lead pipeline should not run in contract-authority test");
    },
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 3,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner,
    agentLoopRunner
  });

  assert.equal(outcome.status, "completed");
  assert.equal(delegatedInput?.taskContract?.requiredDeliverable, "Return a concise ranked list of recent kid-friendly video games.");
  assert.equal(delegatedInput?.taskContract?.requiresDraft, false);
  assert.equal(delegatedInput?.taskContract?.requiresCitations, false);
  assert.equal(delegatedInput?.taskContract?.minimumCitationCount, 0);
  assert.equal(delegatedInput?.taskContract?.targetWordCount, null);
  assert.equal(delegatedInput?.taskContract?.requestedOutputPath, "workspace/alfred/artifacts/games.md");
  assert.equal(delegatedInput?.taskContract?.preferredOutputShape, "ranked_list");
  assert.deepEqual(delegatedInput?.taskContract?.assumptions, ["No board games unless explicitly requested."]);
});

test("runAlfredOrchestratorLoop respects planner choice without forcing delegation", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-planner-choice");
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
          thought: "Need clarifications first before execution.",
          actionType: "respond" as const,
          responseKind: "clarification" as const,
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
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner),
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
  assert.equal(delegated, false);
  assert.equal(outcome.assistantText, "Please clarify exclusions.");
  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "alfred_clarification_requested"));
  assert.ok(!events.some((event) => event.eventType === "alfred_plan_adjusted"));
});

test("runAlfredOrchestratorLoop keeps simple ranked-list research tasks in Alfred loop", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-simple-research-direct");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Give me a ranked list of recent kid-friendly video games.",
    "running"
  );

  let delegated = false;
  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_turn_interpretation") {
      return {
        result: {
          thought: "This is a concise ranked-list research task.",
          groundedObjective: "Give me a ranked list of recent kid-friendly video games.",
          taskType: "general" as const,
          requiredDeliverable: "Return a concise ranked list of recent kid-friendly video games.",
          hardConstraints: ["Video games only.", "Ranked list format."],
          doneCriteria: ["Return a ranked list directly.", "Do not delegate unless the task becomes materially more complex."],
          assumptions: [],
          requiresDraft: false,
          requiresCitations: false,
          targetWordCount: null,
          requestedOutputPath: null,
          clarificationNeeded: false,
          clarificationQuestion: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Delegate to research_agent.",
          actionType: "delegate_agent" as const,
          responseKind: null,
          delegateAgent: "research_agent",
          delegateBrief: "Research and compile the ranked list.",
          toolName: null,
          toolInputJson: null,
          responseText: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "The direct search result is enough for this routing test.",
          shouldRespond: true,
          responseText: "Handled directly in Alfred loop.",
          continueReason: null,
          confidence: 0.9
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Give me a ranked list of recent kid-friendly video games.",
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
      throw new Error("lead pipeline should not run in simple research direct test");
    },
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 3,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner,
    agentLoopRunner: async () => {
      delegated = true;
      return {
        status: "completed",
        assistantText: "Delegated."
      };
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Handled directly in Alfred loop.");
  assert.equal(delegated, false);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const adjustedEvent = events.find(
    (event) =>
      event.eventType === "alfred_plan_adjusted"
      && (event.payload as { reason?: string }).reason === "simple_research_task_direct_execution"
  );
  assert.ok(adjustedEvent);
  const toolCall = updatedRun?.toolCalls.find((call) => call.toolName === "search");
  assert.ok(toolCall);
});

test("runAlfredOrchestratorLoop exposes full runtime catalogs to planner", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-catalogs");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Plan available capabilities for this turn and respond.", "running");

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string; messages?: Array<{ role: string; content: string }> }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      const plannerInput = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
        availableTools?: Array<{ name?: string; inputContract?: { bounds?: string[] } }>;
        availableAgents?: Array<{ name?: string }>;
      };
      const toolNames = new Set((plannerInput.availableTools ?? []).map((tool) => tool.name));
      const agentNames = new Set((plannerInput.availableAgents ?? []).map((agent) => agent.name));
      const searchTool = (plannerInput.availableTools ?? []).find((tool) => tool.name === "search");
      assert.ok(toolNames.has("lead_pipeline"));
      assert.ok(toolNames.has("shell_exec"));
      assert.ok(toolNames.has("file_read"));
      assert.ok((searchTool?.inputContract?.bounds ?? []).some((bound) => bound.includes("maxResults <= 15")));
      assert.ok(agentNames.has("lead_agent"));
      assert.ok(agentNames.has("research_agent"));
      assert.ok(agentNames.has("ops_agent"));
      return {
        result: {
          thought: "Catalogs are available; respond directly.",
          actionType: "respond" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Catalogs verified."
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Plan available capabilities for this turn and respond.",
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
      throw new Error("lead pipeline should not run in catalog test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner)
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Catalogs verified.");
});

test("runAlfredOrchestratorLoop respects plan-only execution permission and does not execute", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-plan-only");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "/plan find 20 MSP leads in Texas with emails",
    "running"
  );

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_lead_execution_brief") {
      return {
        result: {
          thought: "Build execution brief from user request.",
          requestedLeadCount: 20,
          emailRequired: true,
          outputFormat: null,
          objectiveBrief: {
            objectiveSummary: "Find 20 MSP leads in Texas with emails.",
            companyType: "MSP",
            industry: null,
            geography: "Texas",
            businessModel: null,
            contactRequirement: "email required",
            constraintsMissing: []
          }
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Delegate to lead_agent for execution.",
          actionType: "delegate_agent" as const,
          delegateAgent: "lead_agent",
          delegateBrief: "Find 20 MSP leads in Texas with emails.",
          toolName: null,
          toolInputJson: null,
          responseText: null
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
    message: "/plan find 20 MSP leads in Texas with emails",
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
      throw new Error("lead pipeline should not run in plan-only test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner),
    agentLoopRunner: async () => {
      delegated = true;
      return {
        status: "completed",
        assistantText: "Should not be called."
      };
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(delegated, false);
  assert.match(outcome.assistantText ?? "", /plan-only/i);

  const updatedRun = await runStore.getRun(run.runId);
  assert.equal(updatedRun?.toolCalls.length, 0);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "alfred_turn_mode_selected" &&
        (event.payload as { executionPermission?: string }).executionPermission === "plan_only"
    )
  );
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "alfred_plan_adjusted" &&
        (event.payload as { reason?: string }).reason === "execution_permission_plan_only"
    )
  );
});

test("runAlfredOrchestratorLoop treats /diagnose run-id prompts as diagnostic mode", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-run-id-diagnostic");
  const runStore = new RunStore(workspace);
  const prior = await runStore.createRun("session-1", "Sample prior run", "completed");
  await runStore.updateRun(prior.runId, {
    status: "completed",
    assistantText: "Previous run completed with failures."
  });

  const run = await runStore.createRun("session-1", `/diagnose ${prior.runId}`, "running");

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: `/diagnose ${prior.runId}`,
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
      throw new Error("lead pipeline should not run in diagnostic mode test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: async () => {
      throw new Error("planner should not run for diagnostic mode");
    },
    agentLoopRunner: async () => {
      throw new Error("delegation should not run for diagnostic mode");
    }
  });

  assert.equal(outcome.status, "completed");
  assert.match(outcome.assistantText ?? "", new RegExp(prior.runId));
  const updatedRun = await runStore.getRun(run.runId);
  assert.equal(updatedRun?.toolCalls.length, 0);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "alfred_turn_mode_selected" &&
        (event.payload as { turnMode?: string }).turnMode === "diagnostic"
    )
  );
});

test("runAlfredOrchestratorLoop does not misclassify article prompts containing 'why' as diagnostic", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-why-in-article-prompt");
  const runStore = new RunStore(workspace);
  const message =
    "Write me an ~800 word article on the latest AI coding agents. Rank the top 5 and mention why. Save to workspace/alfred/artifacts/blog_test/agents.md and proceed.";
  const run = await runStore.createRun("session-1", message, "running");
  let plannerCalled = false;

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message,
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
      throw new Error("lead pipeline should not run in why-in-article-prompt test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(async <T>(options: { schemaName: string; messages?: Array<{ role: string; content: string }> }): Promise<StructuredChatDiagnostic<T>> => {
      plannerCalled = true;
      if (options.schemaName === "alfred_orchestrator_plan") {
        return {
          result: {
            thought: "Proceed with writing flow.",
            actionType: "respond" as const,
            responseKind: "final" as const,
            delegateAgent: null,
            delegateBrief: null,
            toolName: null,
            toolInputJson: null,
            responseText: "Executing article workflow."
          }
        } as StructuredChatDiagnostic<T>;
      }
      throw new Error(`unexpected schema request: ${options.schemaName}`);
    })
  });

  assert.ok(outcome.status === "completed" || outcome.status === "failed");
  assert.ok(!/Run diagnosis for/i.test(outcome.assistantText ?? ""));
  assert.equal(plannerCalled, true);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "alfred_turn_mode_selected" &&
        (event.payload as { turnMode?: string }).turnMode === "execute"
    )
  );
  assert.ok(!events.some((event) => event.eventType === "alfred_diagnostic_response"));
});

test("runAlfredOrchestratorLoop carries forward objective on follow-up execute turns", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-followup-objective");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Try again", "running");

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string; messages?: Array<{ role: string; content: string }> }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      const plannerInput = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
        turnObjective?: string;
      };
      assert.match(plannerInput.turnObjective ?? "", /Research today's top AI news/i);
      assert.match(plannerInput.turnObjective ?? "", /Follow-up instruction: Try again/i);
      return {
        result: {
          thought: "Objective is clear from session follow-up context.",
          actionType: "respond" as const,
          responseKind: "progress" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Proceeding with carried objective."
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Try again",
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
      throw new Error("lead pipeline should not run in follow-up objective test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner),
    sessionContext: {
      activeObjective: "Try again",
      recentTurns: [
        {
          role: "user",
          content:
            "Research today's top AI news, draft an 800-1000 word blog post with citations, and save it to workspace/alfred/artifacts/blog_test/latest.md.",
          timestamp: "2026-03-14T10:00:00.000Z"
        },
        {
          role: "assistant",
          content: "Last run stalled in search-only mode.",
          timestamp: "2026-03-14T10:00:30.000Z"
        },
        {
          role: "user",
          content: "Try again",
          timestamp: "2026-03-14T10:01:00.000Z"
        }
      ]
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Proceeding with carried objective.");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const resolvedEvent = events.find((event) => event.eventType === "alfred_turn_objective_resolved");
  assert.ok(resolvedEvent);
  assert.equal((resolvedEvent?.payload as { source?: string }).source, "recent_turn");
  const objectiveContractEvent = events.find((event) => event.eventType === "alfred_objective_contract_created");
  assert.ok(objectiveContractEvent);
  assert.match(
    ((objectiveContractEvent?.payload as { objectiveContract?: { requiredDeliverable?: string } })?.objectiveContract
      ?.requiredDeliverable ?? ""),
    /blog draft/i
  );
});

test("runAlfredOrchestratorLoop treats 'You decide' as follow-up continuation of the prior objective", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-followup-you-decide");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "You decide", "running");

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string; messages?: Array<{ role: string; content: string }> }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      const plannerInput = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
        turnObjective?: string;
      };
      assert.match(plannerInput.turnObjective ?? "", /Research the latest AI chip announcements/i);
      assert.match(plannerInput.turnObjective ?? "", /Follow-up instruction: You decide/i);
      return {
        result: {
          thought: "Continue with previous objective and choose defaults.",
          actionType: "respond" as const,
          responseKind: "progress" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Proceeding with chosen defaults."
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "You decide",
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
      throw new Error("lead pipeline should not run in follow-up 'You decide' test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner),
    sessionContext: {
      activeObjective: "You decide",
      recentTurns: [
        {
          role: "user",
          content: "Research the latest AI chip announcements and draft an 800-word article with citations.",
          timestamp: "2026-03-15T18:00:00.000Z"
        },
        {
          role: "assistant",
          content: "Which angle should I prioritize?",
          timestamp: "2026-03-15T18:00:20.000Z"
        },
        {
          role: "user",
          content: "You decide",
          timestamp: "2026-03-15T18:00:35.000Z"
        }
      ]
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Proceeding with chosen defaults.");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const resolvedEvent = events.find((event) => event.eventType === "alfred_turn_objective_resolved");
  assert.ok(resolvedEvent);
  assert.equal((resolvedEvent?.payload as { source?: string }).source, "recent_turn");
});

test("runAlfredOrchestratorLoop can ground a follow-up turn against recent session outputs", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-recent-output-grounding");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Paste it here", "running");

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string; messages?: Array<{ role: string; content: string }> }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_turn_grounding") {
      return {
        result: {
          thought: "User is referring to the latest article artifact in session memory.",
          source: "recent_output" as const,
          groundedObjective:
            "Use the recent session article output titled 'Iran conflict analysis' and paste it here for the user. If the saved artifact is available, paste it directly; otherwise explain what is available and how to regenerate it.",
          referencedOutputId: "run-prev:article"
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_orchestrator_plan") {
      const plannerInput = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
        turnObjective?: string;
        resolvedSessionOutput?: { artifactPath?: string; availability?: string; title?: string };
      };
      assert.match(plannerInput.turnObjective ?? "", /Iran conflict analysis/i);
      assert.match(plannerInput.turnObjective ?? "", /paste it here/i);
      assert.equal(
        plannerInput.resolvedSessionOutput?.artifactPath,
        "workspace/alfred/sessions/session-1/outputs/run-prev-article.md"
      );
      assert.equal(plannerInput.resolvedSessionOutput?.availability, "body_available");
      assert.equal(plannerInput.resolvedSessionOutput?.title, "Iran conflict analysis");
      return {
        result: {
          thought: "Grounded objective is clear from session output memory.",
          actionType: "respond" as const,
          responseKind: "progress" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Proceeding with the grounded article output."
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Paste it here",
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
      throw new Error("lead pipeline should not run in recent-output grounding test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner),
    sessionContext: {
      activeObjective: "Paste it here",
      recentOutputs: [
        {
          id: "run-prev:article",
          kind: "article",
          runId: "run-prev",
          createdAt: "2026-03-16T09:00:00.000Z",
          title: "Iran conflict analysis",
          summary: "A fully cited article about the Iran conflict.",
          artifactPath: "workspace/alfred/sessions/session-1/outputs/run-prev-article.md",
          availability: "body_available",
          metadata: {
            wordCount: 930,
            outputFormat: "blog_post"
          }
        }
      ],
      recentTurns: [
        {
          role: "user",
          content: "Research the Iran conflict and write a cited article.",
          timestamp: "2026-03-16T09:00:00.000Z"
        },
        {
          role: "assistant",
          content: "The article has been prepared and saved.",
          timestamp: "2026-03-16T09:01:00.000Z"
        }
      ]
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Proceeding with the grounded article output.");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const resolvedEvent = events.find((event) => event.eventType === "alfred_turn_objective_resolved");
  assert.ok(resolvedEvent);
  assert.equal((resolvedEvent?.payload as { source?: string }).source, "recent_output");
});

test("runAlfredOrchestratorLoop does not carry stale artifact obligations into a fresh standalone turn", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-fresh-turn-no-stale-artifact");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Please give me a list of the top 10 family-friendly PC games from 2025 and 2026.",
    "running"
  );

  let delegatedInput: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["agentLoopRunner"]> extends (
    options: infer TOptions
  ) => Promise<unknown>
    ? TOptions | undefined
    : never;

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string; messages?: Array<{ role: string; content: string }> }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_turn_grounding") {
      return {
        result: {
          thought: "The current turn is a fresh standalone request.",
          source: "message" as const,
          groundedObjective: "Please give me a list of the top 10 family-friendly PC games from 2025 and 2026.",
          referencedOutputId: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_turn_interpretation") {
      return {
        result: {
          thought: "Interpret the current request directly.",
          groundedObjective: "Please give me a list of the top 10 family-friendly PC games from 2025 and 2026.",
          taskType: "general" as const,
          requiredDeliverable: "Produce a ranked top-10 recommendation list.",
          hardConstraints: [
            "Use the existing prior artifact at workspace/alfred/sessions/session-1/outputs/run-prev-article.md."
          ],
          doneCriteria: [
            "Write the result to workspace/alfred/sessions/session-1/outputs/run-prev-article.md."
          ],
          assumptions: [
            "Reuse the previous artifact at workspace/alfred/sessions/session-1/outputs/run-prev-article.md if possible."
          ],
          requiresDraft: true,
          requiresCitations: false,
          targetWordCount: 900,
          requestedOutputPath: "workspace/alfred/sessions/session-1/outputs/run-prev-article.md",
          clarificationNeeded: false,
          clarificationQuestion: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Delegate to research_agent.",
          actionType: "delegate_agent" as const,
          responseKind: null,
          delegateAgent: "research_agent",
          delegateBrief: "Research and compile the ranked game list.",
          toolName: null,
          toolInputJson: null,
          responseText: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "Delegated result is enough for this regression test.",
          shouldRespond: true,
          responseText: "Delegated result accepted.",
          continueReason: null,
          confidence: 0.9
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const agentLoopRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["agentLoopRunner"]> = async (options) => {
    delegatedInput = options;
    return {
      status: "completed",
      assistantText: "Research delegated.",
      artifactPaths: []
    };
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Please give me a list of the top 10 family-friendly PC games from 2025 and 2026.",
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
      throw new Error("lead pipeline should not run in stale-artifact carryover test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner,
    agentLoopRunner,
    sessionContext: {
      activeObjective: "Paste the previous article here.",
      recentOutputs: [
        {
          id: "run-prev:article",
          kind: "article",
          runId: "run-prev",
          createdAt: "2026-03-16T09:00:00.000Z",
          title: "Old article",
          summary: "A prior saved article artifact.",
          artifactPath: "workspace/alfred/sessions/session-1/outputs/run-prev-article.md",
          availability: "body_available"
        }
      ],
      recentTurns: [
        {
          role: "user",
          content: "Paste the previous article here.",
          timestamp: "2026-03-16T09:00:00.000Z"
        }
      ]
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(delegatedInput?.taskContract?.requestedOutputPath, null);
  assert.ok(
    !(delegatedInput?.taskContract?.doneCriteria ?? []).some((item) => item.includes("workspace/alfred/sessions/session-1/outputs/run-prev-article.md"))
  );
});

test("runAlfredOrchestratorLoop rejects stale recent-output grounding for a fresh standalone request", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-reject-stale-grounding");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Please give me a list of up to 10 games that I can play with my kids aged 7 to 13.",
    "running"
  );

  let delegatedInput: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["agentLoopRunner"]> extends (
    options: infer TOptions
  ) => Promise<unknown>
    ? TOptions | undefined
    : never;

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string; messages?: Array<{ role: string; content: string }> }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_turn_grounding") {
      return {
        result: {
          thought: "Use the previous memo as the base.",
          source: "recent_output" as const,
          groundedObjective:
            "Finalize the game list based on the existing draft memo at workspace/alfred/sessions/session-1/outputs/run-prev-memo.md.",
          referencedOutputId: "run-prev:draft"
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_turn_interpretation") {
      const payload = JSON.parse(options.messages?.[1]?.content ?? "{}") as { groundedObjective?: string; groundedSource?: string };
      assert.equal(payload.groundedSource, "message");
      assert.equal(
        payload.groundedObjective,
        "Please give me a list of up to 10 games that I can play with my kids aged 7 to 13."
      );
      return {
        result: {
          thought: "Interpret the fresh request directly.",
          groundedObjective: "Please give me a list of up to 10 games that I can play with my kids aged 7 to 13.",
          taskType: "general" as const,
          requiredDeliverable: "Produce the requested recommendation list.",
          hardConstraints: [],
          doneCriteria: ["Return the requested list directly."],
          assumptions: [],
          requiresDraft: false,
          requiresCitations: false,
          targetWordCount: null,
          requestedOutputPath: null,
          clarificationNeeded: false,
          clarificationQuestion: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_orchestrator_plan") {
      const payload = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
        turnObjective?: string;
        resolvedSessionOutput?: unknown;
      };
      assert.equal(payload.turnObjective, "Please give me a list of up to 10 games that I can play with my kids aged 7 to 13.");
      assert.equal(payload.resolvedSessionOutput ?? null, null);
      return {
        result: {
          thought: "Delegate the fresh request.",
          actionType: "delegate_agent" as const,
          responseKind: null,
          delegateAgent: "research_agent",
          delegateBrief: "Research and compile the game list.",
          toolName: null,
          toolInputJson: null,
          responseText: null
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "Delegated result is enough for this regression test.",
          shouldRespond: true,
          responseText: "Delegated result accepted.",
          continueReason: null,
          confidence: 0.9
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const agentLoopRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["agentLoopRunner"]> = async (options) => {
    delegatedInput = options;
    return {
      status: "completed",
      assistantText: "Research delegated.",
      artifactPaths: []
    };
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Please give me a list of up to 10 games that I can play with my kids aged 7 to 13.",
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
      throw new Error("lead pipeline should not run in stale-grounding rejection test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner,
    agentLoopRunner,
    sessionContext: {
      recentOutputs: [
        {
          id: "run-prev:draft",
          kind: "draft",
          runId: "run-prev",
          createdAt: "2026-03-16T09:00:00.000Z",
          title: "Old memo",
          summary: "A failed planning memo from an earlier run.",
          artifactPath: "workspace/alfred/sessions/session-1/outputs/run-prev-memo.md",
          availability: "metadata_only"
        }
      ]
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(delegatedInput, undefined);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const resolvedEvent = events.find((event) => event.eventType === "alfred_turn_objective_resolved");
  assert.ok(!resolvedEvent);
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "alfred_plan_adjusted"
        && (event.payload as { reason?: string }).reason === "simple_research_task_direct_execution"
    )
  );
});

test("runAlfredOrchestratorLoop can recover session outputs from durable run history", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-durable-output-recovery");
  const runStore = new RunStore(workspace);
  const previousRun = await runStore.createRun(
    "session-1",
    "Research the chip market and write a sector brief.",
    "completed"
  );
  const artifactPath = `workspace/alfred/sessions/session-1/outputs/${previousRun.runId}-article.md`;
  await mkdir(`${workspace}/workspace/alfred/sessions/session-1/outputs`, { recursive: true });
  await writeFile(
    `${workspace}/${artifactPath}`,
    "# Semiconductor Brief\n\nThe draft body was persisted to a session artifact.\n",
    "utf8"
  );
  await runStore.addToolCall(previousRun.runId, {
    toolName: "writer_agent",
    inputRedacted: {
      instruction: "Write a sector brief"
    },
    outputRedacted: {
      title: "Semiconductor Brief",
      format: "blog_post",
      wordCount: 640,
      content: "The draft body was persisted to a session artifact.",
      draftQuality: "complete"
    },
    durationMs: 1_200,
    status: "ok",
    timestamp: new Date().toISOString()
  });
  await runStore.updateRun(previousRun.runId, {
    status: "completed",
    artifactPaths: [artifactPath],
    assistantText: "The sector brief was drafted and saved."
  });

  const run = await runStore.createRun("session-1", "Use the previous brief as the basis for the next response.", "running");

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string; messages?: Array<{ role: string; content: string }> }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_turn_grounding") {
      const groundingInput = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
        recentOutputs?: Array<{ id?: string; title?: string; artifactPath?: string | null }>;
      };
      assert.equal(groundingInput.recentOutputs?.length, 1);
      assert.equal(groundingInput.recentOutputs?.[0]?.title, "Semiconductor Brief");
      assert.equal(groundingInput.recentOutputs?.[0]?.artifactPath, artifactPath);
      return {
        result: {
          thought: "The user is referring to the stored prior brief.",
          source: "recent_output" as const,
          groundedObjective:
            "Use the stored session brief titled 'Semiconductor Brief' as the basis for the next response. Reuse the saved body if available.",
          referencedOutputId: `${previousRun.runId}:article`
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_orchestrator_plan") {
      const plannerInput = JSON.parse(options.messages?.[1]?.content ?? "{}") as {
        resolvedSessionOutput?: {
          title?: string;
          artifactPath?: string;
          availability?: string;
          bodyPreview?: string | null;
          bodyPreviewTruncated?: boolean;
        };
      };
      assert.equal(plannerInput.resolvedSessionOutput?.title, "Semiconductor Brief");
      assert.equal(plannerInput.resolvedSessionOutput?.artifactPath, artifactPath);
      assert.equal(plannerInput.resolvedSessionOutput?.availability, "body_available");
      assert.match(plannerInput.resolvedSessionOutput?.bodyPreview ?? "", /persisted to a session artifact/i);
      assert.equal(plannerInput.resolvedSessionOutput?.bodyPreviewTruncated, false);
      return {
        result: {
          thought: "Durable memory recovery supplied the prior brief.",
          actionType: "respond" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Recovered the stored session brief."
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Use the previous brief as the basis for the next response.",
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
      throw new Error("lead pipeline should not run in durable-output recovery test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner),
    sessionContext: {
      recentTurns: [
        {
          role: "assistant",
          content: "The brief was completed in the previous turn.",
          timestamp: "2026-03-16T09:01:00.000Z"
        }
      ]
    }
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Recovered the stored session brief.");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "alfred_session_outputs_recovered"));
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
    "/diagnose",
    "running"
  );

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "/diagnose",
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

test("runAlfredOrchestratorLoop blocks respond when completion violates objective contract", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-completion-contract");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI news for the week and draft a cited blog post.",
    "running"
  );

  let planCalls = 0;
  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      planCalls += 1;
      if (planCalls === 1) {
        return {
          result: {
            thought: "Run diagnostics first.",
            actionType: "call_tool" as const,
            delegateAgent: null,
            delegateBrief: null,
            toolName: "run_diagnostics",
            toolInputJson: JSON.stringify({ runId: run.runId }),
            responseText: null
          }
        } as StructuredChatDiagnostic<T>;
      }
      return {
        result: {
          thought: "No further action.",
          actionType: "respond" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Stopping."
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "We should respond now.",
          shouldRespond: true,
          responseText: "Here is a short summary without citations.",
          continueReason: null,
          confidence: 0.9
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Research AI news for the week and draft a cited blog post.",
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
      throw new Error("lead pipeline should not run in completion contract test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner)
  });

  assert.equal(outcome.status, "completed");
  assert.notEqual(outcome.assistantText, "Here is a short summary without citations.");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "alfred_completion_contract_blocked"));
});

test("runAlfredOrchestratorLoop blocks completion when requested output path is missing", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-output-path-contract");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI news and save draft to workspace/alfred/artifacts/blog_test/latest.md",
    "running"
  );

  let planCalls = 0;
  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      planCalls += 1;
      if (planCalls === 1) {
        return {
          result: {
            thought: "Run diagnostics first.",
            actionType: "call_tool" as const,
            delegateAgent: null,
            delegateBrief: null,
            toolName: "run_diagnostics",
            toolInputJson: JSON.stringify({ runId: run.runId }),
            responseText: null
          }
        } as StructuredChatDiagnostic<T>;
      }
      return {
        result: {
          thought: "No further action.",
          actionType: "respond" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Done."
        }
      } as StructuredChatDiagnostic<T>;
    }
    if (options.schemaName === "alfred_completion_evaluation") {
      return {
        result: {
          thought: "Looks complete enough.",
          shouldRespond: true,
          responseText: "Done.",
          continueReason: null,
          confidence: 0.9
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message: "Research AI news and save draft to workspace/alfred/artifacts/blog_test/latest.md",
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
      throw new Error("lead pipeline should not run in output-path contract test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner)
  });

  assert.equal(outcome.status, "completed");
  assert.notEqual(outcome.assistantText, "Done.");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const blocked = events.find((event) => event.eventType === "alfred_completion_contract_blocked");
  assert.ok(blocked);
  assert.match(JSON.stringify(blocked?.payload ?? {}), /requested output saved/i);
});

test("runAlfredOrchestratorLoop allows respond when draft/citation/output evidence already satisfies contract", async () => {
  const workspace = await createTempWorkspace("alfred-orchestrator-writing-contract-satisfied");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI news and write an 800-1000 word article with citations. Save to workspace/alfred/artifacts/blog_test/latest.md. You decide and proceed.",
    "running"
  );

  const richContent = `${"AI policy updates and market context. ".repeat(80)} Sources: https://example.com/a https://example.com/b`;
  await runStore.addToolCall(run.runId, {
    toolName: "article_writer",
    inputRedacted: {
      instruction: "Write the article",
      outputPath: "workspace/alfred/artifacts/blog_test/latest.md"
    },
    outputRedacted: {
      wordCount: 860,
      content: richContent,
      outputPath: "workspace/alfred/artifacts/blog_test/latest.md",
      draftQuality: "complete",
      fallbackUsed: false
    },
    durationMs: 1800,
    status: "ok",
    timestamp: new Date().toISOString()
  });
  await runStore.updateRun(run.runId, {
    artifactPaths: ["workspace/alfred/artifacts/blog_test/latest.md"]
  });

  const structuredChatRunner: NonNullable<Parameters<typeof runAlfredOrchestratorLoop>[0]["structuredChatRunner"]> = async <
    T
  >(
    options: { schemaName: string }
  ): Promise<StructuredChatDiagnostic<T>> => {
    if (options.schemaName === "alfred_orchestrator_plan") {
      return {
        result: {
          thought: "Evidence already satisfies the objective, return final answer.",
          actionType: "respond" as const,
          delegateAgent: null,
          delegateBrief: null,
          toolName: null,
          toolInputJson: null,
          responseText: "Done. The draft has been saved."
        }
      } as StructuredChatDiagnostic<T>;
    }
    throw new Error(`unexpected schema request: ${options.schemaName}`);
  };

  const outcome = await runAlfredOrchestratorLoop({
    runStore,
    searchManager: new FakeSearchManager() as unknown as SearchManager,
    workspaceDir: workspace,
    message:
      "Research AI news and write an 800-1000 word article with citations. Save to workspace/alfred/artifacts/blog_test/latest.md. You decide and proceed.",
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
      throw new Error("lead pipeline should not run in writing-contract-satisfied test");
    },
    maxIterations: 2,
    maxDurationMs: 30_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    structuredChatRunner: withDefaultTurnInterpretation(structuredChatRunner)
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.assistantText, "Done. The draft has been saved.");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.equal(events.some((event) => event.eventType === "alfred_completion_contract_blocked"), false);
});
