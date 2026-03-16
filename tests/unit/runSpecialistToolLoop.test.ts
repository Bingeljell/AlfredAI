import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../src/runs/runStore.js";
import { runSpecialistToolLoop, shouldApplyAssemblyGuard, shouldForcePhaseTransition } from "../../src/core/runSpecialistToolLoop.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class FakeSearchManager {
  async search() {
    return {
      provider: "searxng" as const,
      fallbackUsed: false,
      results: []
    };
  }
}

class FakeSearchManagerWithResults {
  async search(query: string) {
    return {
      provider: "searxng" as const,
      fallbackUsed: false,
      results: [
        {
          title: `Result for ${query}`,
          url: `https://example.com/${encodeURIComponent(query)}`,
          snippet: "Example snippet",
          provider: "searxng" as const,
          rank: 1
        }
      ]
    };
  }
}

class HealthyStatusSearchManager {
  async search(query: string) {
    return {
      provider: "searxng" as const,
      fallbackUsed: false,
      results: [
        {
          title: `Result for ${query}`,
          url: `https://example.com/${encodeURIComponent(query)}`,
          snippet: "Example snippet",
          provider: "searxng" as const,
          rank: 1
        }
      ]
    };
  }

  async getProviderStatus() {
    return {
      primaryProvider: "searxng",
      fallbackProvider: "brightdata",
      primaryHealthy: true,
      fallbackHealthy: true,
      primaryRecoverySupported: true,
      activeDefault: "searxng",
      lastPrimaryHealthyAt: new Date().toISOString(),
      consecutivePrimaryFailures: 0
    };
  }
}

class TimeoutSearchManager {
  async search() {
    throw new Error("The operation was aborted due to timeout");
  }
}

test("runSpecialistToolLoop exits with policy block when planner auth fails", async () => {
  const workspace = await createTempWorkspace("specialist-policy-block");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "research this", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "research this",
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
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["run_diagnostics"],
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
  assert.ok(events.some((event) => event.eventType === "specialist_planner_failed"));
});

test("runSpecialistToolLoop enforces research contract before allowing respond", async () => {
  const workspace = await createTempWorkspace("specialist-contract-gate");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI news and draft a cited blog post",
    "running"
  );

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "Research AI news and draft a cited blog post",
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
    maxIterations: 1,
    maxDurationMs: 60_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search", "run_diagnostics"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "I can answer now.",
          actionType: "respond",
          singleTool: null,
          singleInputJson: null,
          parallelActions: null,
          responseText: "Here is a short summary."
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  assert.match(outcome.assistantText ?? "", /couldn't finish a publish-ready draft/i);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "specialist_contract_blocked"));
});

test("runSpecialistToolLoop blocks unsupported long-form respond attempts without evidence backing", async () => {
  const workspace = await createTempWorkspace("specialist-unsupported-respond");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI news and draft a cited blog post",
    "running"
  );

  const longUnsupportedDraft = Array.from({ length: 210 }, () => "analysis").join(" ");
  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "Research AI news and draft a cited blog post",
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
    maxIterations: 1,
    maxDurationMs: 60_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "I can answer now.",
          actionType: "respond",
          singleTool: null,
          singleInputJson: null,
          parallelActions: null,
          responseText: longUnsupportedDraft
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  assert.match(outcome.assistantText ?? "", /couldn't finish a publish-ready draft/i);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const blockedEvent = events.find((event) => event.eventType === "specialist_contract_blocked");
  assert.ok(blockedEvent);
  const unmet = (blockedEvent?.payload as { unmet?: string[] } | undefined)?.unmet ?? [];
  assert.ok(unmet.includes("supporting_evidence_missing"));
  assert.ok(unmet.includes("synthesis_not_ready"));
});

test("runSpecialistToolLoop blocks specialist clarification when task contract disallows it", async () => {
  const workspace = await createTempWorkspace("specialist-clarification-lock");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Proceed with defaults", "running");

  let plannerStep = 0;
  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Proceed with defaults",
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
    maxIterations: 2,
    maxDurationMs: 60_000,
    maxToolCalls: 3,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    taskContract: {
      requiredDeliverable: "Produce a verified ranked list from gathered evidence.",
      requiresAssembly: true,
      requiresDraft: false,
      requiresCitations: false,
      minimumCitationCount: 0,
      doneCriteria: ["Return the ranked list once evidence is gathered."],
      clarificationAllowed: false
    },
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["lead_search_shortlist"],
    structuredChatRunner: async <T>() => {
      plannerStep += 1;
      if (plannerStep === 1) {
        return {
          result: {
            thought: "Shortlist likely sources first.",
            actionType: "single",
            responseKind: null,
            singleTool: "lead_search_shortlist",
            singleInputJson: JSON.stringify({ query: "family friendly pc games", maxResults: 8, maxUrls: 8 }),
            parallelActions: null,
            responseText: null
          }
        } as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>;
      }
      return {
        result: {
          thought: "Ask a follow-up question.",
          actionType: "respond",
          responseKind: "clarification",
          singleTool: null,
          singleInputJson: null,
          parallelActions: null,
          responseText: "Should I prioritize critic scores or co-op value?"
        }
      } as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>;
    }
  });

  assert.equal(outcome.status, "completed");
  assert.doesNotMatch(outcome.assistantText ?? "", /critic scores or co-op value/i);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted"
        && (event.payload as { reason?: string }).reason === "specialist_clarification_blocked"
    )
  );
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_phase_state"
        && (event.payload as { phase?: string }).phase === "fetch"
    )
  );
});

test("runSpecialistToolLoop triggers loop-shape guard after repeated search-only iterations", async () => {
  const workspace = await createTempWorkspace("specialist-loop-shape-guard");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "research this", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "Research this topic",
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
    maxIterations: 6,
    maxDurationMs: 60_000,
    maxToolCalls: 10,
    maxParallelTools: 1,
    plannerMaxCalls: 6,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Search first.",
          actionType: "single",
          singleTool: "search",
          singleInputJson: JSON.stringify({ query: "ai news", maxResults: 5 }),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "specialist_loop_guard_triggered"));
});

test("runSpecialistToolLoop emits phase-transition hint before search-only guard for research tasks", async () => {
  const workspace = await createTempWorkspace("specialist-phase-transition-hint");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "research this", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Research today's AI news and draft a cited blog post",
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
    maxIterations: 5,
    maxDurationMs: 60_000,
    maxToolCalls: 10,
    maxParallelTools: 1,
    plannerMaxCalls: 6,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Search first.",
          actionType: "single",
          singleTool: "search",
          singleInputJson: JSON.stringify({ query: "ai news", maxResults: 5 }),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");

  const updatedRun = await runStore.getRun(run.runId);
  assert.equal(updatedRun?.toolCalls.length, 4);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(events.some((event) => event.eventType === "specialist_phase_state"));
  assert.ok(events.some((event) => event.eventType === "specialist_phase_transition_required"));
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_loop_guard_triggered" &&
        (event.payload as { threshold?: number }).threshold === 4
    )
  );
});

test("runSpecialistToolLoop exposes generic active-work state to the planner", async () => {
  const workspace = await createTempWorkspace("specialist-active-work-state");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Research today's AI news and draft a cited post", "running");

  let plannerStep = 0;
  let secondPlannerPayload: Record<string, unknown> | null = null;

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Research today's AI news and draft a cited post",
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
    maxIterations: 2,
    maxDurationMs: 60_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search"],
    structuredChatRunner: async <T>({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      plannerStep += 1;
      const payload = JSON.parse(messages[1]?.content ?? "{}") as Record<string, unknown>;
      if (plannerStep === 2) {
        secondPlannerPayload = payload;
      }
      return {
        result: plannerStep === 1
          ? {
              thought: "Search first.",
              actionType: "single",
              singleTool: "search",
              singleInputJson: JSON.stringify({ query: "ai news", maxResults: 5 }),
              parallelActions: null,
              responseText: null
            }
          : {
              thought: "Done.",
              actionType: "respond",
              singleTool: null,
              singleInputJson: null,
              parallelActions: null,
              responseText: "Partial synthesis pending."
            }
      } as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>;
    }
  });

  assert.equal(outcome.status, "completed");
  assert.ok(secondPlannerPayload);
  const plannerPayload = secondPlannerPayload as Record<string, unknown>;
  const activeWorkState = plannerPayload.activeWorkState as {
    assumptions?: Array<{ statement?: string }>;
    activeWorkItems?: Array<{ kind?: string }>;
    candidateSets?: Array<{ itemCount?: number }>;
    evidenceRecords?: Array<{ kind?: string }>;
    synthesisState?: { status?: string; readyForSynthesis?: boolean };
  } | undefined;
  const writerReadiness = plannerPayload.writerReadiness as {
    evidenceReady?: boolean;
    finalizeReady?: boolean;
    missingEvidence?: string[];
    timeBudgetReady?: boolean;
  } | undefined;
  assert.ok(activeWorkState);
  assert.ok(writerReadiness);
  assert.ok((activeWorkState?.assumptions?.length ?? 0) >= 1);
  assert.ok((activeWorkState?.activeWorkItems?.length ?? 0) >= 1);
  assert.ok((activeWorkState?.candidateSets?.length ?? 0) >= 1);
  assert.ok((activeWorkState?.candidateSets?.[0]?.itemCount ?? 0) >= 1);
  assert.ok((activeWorkState?.evidenceRecords?.length ?? 0) >= 1);
  assert.match(activeWorkState?.synthesisState?.status ?? "", /not_ready|emerging|ready|partial|complete/);
  assert.equal(writerReadiness?.evidenceReady, false);
  assert.equal(typeof writerReadiness?.timeBudgetReady, "boolean");
  assert.ok((writerReadiness?.missingEvidence?.length ?? 0) >= 1);
});

test("runSpecialistToolLoop applies flaky-search retry profile to parallel search plans", async () => {
  const workspace = await createTempWorkspace("specialist-flaky-search-profile");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "research this", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new TimeoutSearchManager() as never,
    workspaceDir: workspace,
    message: "Research this topic",
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
    maxIterations: 2,
    maxDurationMs: 60_000,
    maxToolCalls: 10,
    maxParallelTools: 3,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Search broadly in parallel.",
          actionType: "parallel",
          singleTool: null,
          singleInputJson: null,
          parallelActions: [
            { tool: "search", inputJson: JSON.stringify({ query: "ai news 1" }) },
            { tool: "search", inputJson: JSON.stringify({ query: "ai news 2" }) },
            { tool: "search", inputJson: JSON.stringify({ query: "ai news 3" }) }
          ],
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const actionResults = events.filter((event) => event.eventType === "specialist_action_result");
  assert.equal(actionResults.length, 2);
  const firstResultCount = Array.isArray((actionResults[0]?.payload as { results?: unknown[] } | undefined)?.results)
    ? ((actionResults[0]?.payload as { results?: unknown[] }).results?.length ?? 0)
    : 0;
  const secondResultCount = Array.isArray((actionResults[1]?.payload as { results?: unknown[] } | undefined)?.results)
    ? ((actionResults[1]?.payload as { results?: unknown[] }).results?.length ?? 0)
    : 0;
  assert.equal(firstResultCount, 3);
  assert.equal(secondResultCount, 1);
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted" &&
        (event.payload as { reason?: string }).reason === "flaky_search_retry_profile"
    )
  );
});

test("assembly guard reroutes search-heavy synthesis plans once evidence is ready", () => {
  const adjusted = shouldApplyAssemblyGuard({
    skillName: "research_agent",
    phase: "synthesis",
    actions: [{ tool: "search", inputJson: JSON.stringify({ query: "family games" }) }],
    availableToolNames: new Set(["search", "writer_agent"]),
    objective: "Assemble a ranked family-friendly PC games list",
    contract: {
      requiredDeliverable: "A ranked, source-backed list.",
      requiresAssembly: true,
      requiresDraft: false,
      requiresCitations: true,
      minimumCitationCount: 2,
      doneCriteria: ["Return the ranked list with citations."]
    },
    requestedOutputPath: null,
    writerReadiness: {
      evidenceReady: true,
      finalizeReady: true,
      hasReusableEvidence: true,
      missingEvidence: [],
      timeBudgetReady: true,
      outputContractReady: true,
      minimumRemainingMs: 40_000
    }
  });

  assert.equal(adjusted.reason, "assembly_from_evidence_ready");
  assert.ok(adjusted.adjusted);
  assert.equal(adjusted.adjusted?.[0]?.tool, "writer_agent");
});

test("runSpecialistToolLoop forces schema-recovery input rewrite after repeated schema errors", async () => {
  const workspace = await createTempWorkspace("specialist-schema-recovery");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "research this", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "Find top AI news today",
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
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 5,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Search first.",
          actionType: "single",
          singleTool: "search",
          singleInputJson: JSON.stringify({}),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted" &&
        (event.payload as { reason?: string }).reason === "schema_recovery_forced"
    )
  );
  const actionResults = events.filter((event) => event.eventType === "specialist_action_result");
  const lastResults = (actionResults[actionResults.length - 1]?.payload as { results?: Array<{ status?: string }> } | undefined)
    ?.results;
  assert.ok(Array.isArray(lastResults));
  assert.equal(lastResults?.[0]?.status, "ok");
});

test("runSpecialistToolLoop returns latest structured tool output for ops tasks", async () => {
  const workspace = await createTempWorkspace("specialist-ops-structured-output");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Read changelog file", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "Read the changelog file and summarize it",
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
    maxIterations: 6,
    maxDurationMs: 60_000,
    maxToolCalls: 10,
    maxParallelTools: 1,
    plannerMaxCalls: 6,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "ops_agent",
    skillDescription: "Ops skill",
    skillSystemPrompt: "Inspect file contents",
    toolAllowlist: ["file_read"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Read the file first.",
          actionType: "single",
          singleTool: "file_read",
          singleInputJson: JSON.stringify({ path: "docs/changelog.md" }),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  assert.match(outcome.assistantText ?? "", /read file content/i);
  assert.match(outcome.assistantText ?? "", /changelog/i);

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_loop_guard_triggered" &&
        (event.payload as { guard?: string }).guard === "repeated_no_change_success"
    )
  );
});

test("runSpecialistToolLoop applies diagnostic-thrash guard after repeated healthy search_status checks", async () => {
  const workspace = await createTempWorkspace("specialist-diagnostic-thrash-guard");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Research latest AI news", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new HealthyStatusSearchManager() as never,
    workspaceDir: workspace,
    message: "Research latest AI news",
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
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 6,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search_status", "search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "First check search status.",
          actionType: "single",
          singleTool: "search_status",
          singleInputJson: JSON.stringify({}),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted" &&
        (event.payload as { reason?: string }).reason === "diagnostic_thrash_guard"
    )
  );
  const actionResults = events.filter((event) => event.eventType === "specialist_action_result");
  assert.ok(
    actionResults.some((event) =>
      ((event.payload as { summary?: string }).summary ?? "").includes("search:ok")
    )
  );
});

test("runSpecialistToolLoop reroutes premature writer actions when draft evidence is insufficient", async () => {
  const workspace = await createTempWorkspace("specialist-evidence-gap-guard");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI news and draft a blog post with citations",
    "running"
  );

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Research AI news and draft a blog post with citations",
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
    maxIterations: 1,
    maxDurationMs: 60_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["writer_agent", "search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Draft immediately.",
          actionType: "single",
          singleTool: "writer_agent",
          singleInputJson: JSON.stringify({
            instruction: "Write a cited blog post on today's AI news.",
            maxWords: 900,
            format: "blog_post"
          }),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");

  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted"
        && (event.payload as { reason?: string }).reason === "insufficient_evidence_for_writer"
    )
  );
  const actionResultEvent = events.find((event) => event.eventType === "specialist_action_result");
  const results = (actionResultEvent?.payload as { results?: Array<{ tool?: string }> } | undefined)?.results ?? [];
  assert.equal(results[0]?.tool, "search");
  assert.equal(updatedRun?.toolCalls[0]?.toolName, "search");
});

test("runSpecialistToolLoop raises stricter evidence thresholds for long-form cited drafts", async () => {
  const workspace = await createTempWorkspace("specialist-evidence-thresholds-longform");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI news and write a 1200 words draft with citations",
    "running"
  );

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Research AI news and write a 1200 words draft with citations",
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
    maxIterations: 1,
    maxDurationMs: 60_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["writer_agent", "search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Draft immediately.",
          actionType: "single",
          singleTool: "writer_agent",
          singleInputJson: JSON.stringify({
            instruction: "Write a cited long-form article now.",
            maxWords: 1200,
            format: "blog_post"
          }),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const thresholdEvent = events.find(
    (event) =>
      event.eventType === "specialist_plan_adjusted"
      && (event.payload as { reason?: string }).reason === "insufficient_evidence_for_writer"
  );
  assert.ok(thresholdEvent);
  const detail = (thresholdEvent?.payload as { detail?: { minFetchedPages?: number; minSourceCards?: number } } | undefined)?.detail;
  assert.equal(detail?.minFetchedPages, 5);
  assert.equal(detail?.minSourceCards, 8);
});

test("runSpecialistToolLoop applies writer retry budget guard after repeated fallback without new evidence", async () => {
  const workspace = await createTempWorkspace("specialist-writer-retry-guard");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Research AI trend highlights", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Research AI trend highlights",
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
    maxIterations: 2,
    maxDurationMs: 60_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["writer_agent", "search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Draft now.",
          actionType: "single",
          singleTool: "writer_agent",
          singleInputJson: JSON.stringify({
            instruction: "Write an update with current AI trend highlights.",
            maxWords: 700,
            format: "memo"
          }),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted"
        && (event.payload as { reason?: string }).reason === "writer_retry_budget_guard"
    )
  );
  assert.equal(updatedRun?.toolCalls[0]?.toolName, "writer_agent");
  assert.equal(updatedRun?.toolCalls[1]?.toolName, "search");
});

test("runSpecialistToolLoop prefers revise pass before retrieval when evidence already exists", async () => {
  const workspace = await createTempWorkspace("specialist-writer-revise-first");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Research AI trend highlights", "running");

  let plannerStep = 0;
  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Research AI trend highlights",
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
    maxIterations: 3,
    maxDurationMs: 60_000,
    maxToolCalls: 5,
    maxParallelTools: 1,
    plannerMaxCalls: 4,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search", "writer_agent"],
    structuredChatRunner: async <T>() => {
      plannerStep += 1;
      if (plannerStep === 1) {
        return {
          result: {
            thought: "Discover sources first.",
            actionType: "single",
            singleTool: "search",
            singleInputJson: JSON.stringify({ query: "AI trend highlights", maxResults: 8 }),
            parallelActions: null,
            responseText: null
          }
        } as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>;
      }
      return {
        result: {
          thought: "Draft now.",
          actionType: "single",
          singleTool: "writer_agent",
          singleInputJson: JSON.stringify({
            instruction: "Write a brief cited update on current AI trend highlights.",
            maxWords: 500,
            format: "memo"
          }),
          parallelActions: null,
          responseText: null
        }
      } as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>;
    }
  });

  assert.equal(outcome.status, "completed");
  const updatedRun = await runStore.getRun(run.runId);
  assert.equal(updatedRun?.toolCalls[0]?.toolName, "search");
  assert.equal(updatedRun?.toolCalls[1]?.toolName, "writer_agent");
  assert.equal(updatedRun?.toolCalls[2]?.toolName, "writer_agent");
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  const reviseGuardEvent = events.find(
    (event) =>
      event.eventType === "specialist_plan_adjusted"
      && (event.payload as { reason?: string }).reason === "writer_retry_budget_guard"
      && (event.payload as { detail?: { strategy?: string } }).detail?.strategy === "revise_existing_evidence"
  );
  assert.ok(reviseGuardEvent);
});

test("runSpecialistToolLoop injects requested outputPath into writer actions when omitted by planner", async () => {
  const workspace = await createTempWorkspace("specialist-writer-outputpath-inject");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Draft a blog post to workspace/alfred/artifacts/blog.md",
    "running"
  );

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManager() as never,
    workspaceDir: workspace,
    message: "Draft a blog post to workspace/alfred/artifacts/blog.md",
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
    maxIterations: 1,
    maxDurationMs: 60_000,
    maxToolCalls: 2,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["writer_agent"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Write draft.",
          actionType: "single",
          singleTool: "writer_agent",
          singleInputJson: JSON.stringify({
            instruction: "Write a concise blog draft.",
            maxWords: 700,
            format: "blog_post"
          }),
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted"
        && (event.payload as { reason?: string }).reason === "persist_output_path_injected"
    )
  );
});

test("runSpecialistToolLoop does not force writer when remaining budget is below viable writer window", async () => {
  const workspace = await createTempWorkspace("specialist-low-budget-finalize");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun(
    "session-1",
    "Research AI updates with citations and save to workspace/alfred/artifacts/lowbudget.md",
    "running"
  );

  let plannerStep = 0;
  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Research AI updates with citations and save to workspace/alfred/artifacts/lowbudget.md",
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
    maxIterations: 2,
    maxDurationMs: 40_000,
    maxToolCalls: 4,
    maxParallelTools: 1,
    plannerMaxCalls: 3,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search", "writer_agent"],
    structuredChatRunner: async <T>() => {
      plannerStep += 1;
      if (plannerStep <= 2) {
        return {
          result: {
            thought: "Keep searching for more sources.",
            actionType: "single",
            singleTool: "search",
            singleInputJson: JSON.stringify({ query: "latest ai updates", maxResults: 8 }),
            parallelActions: null,
            responseText: null
          }
        } as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>;
      }
      return {
        result: {
          thought: "Done",
          actionType: "respond",
          singleTool: null,
          singleInputJson: null,
          parallelActions: null,
          responseText: "Done"
        }
      } as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>;
    }
  });

  assert.equal(outcome.status, "completed");
  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    !events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted"
        && (event.payload as { reason?: string }).reason === "low_budget_finalize_draft"
    )
  );
  assert.ok(!(updatedRun?.toolCalls.some((call) => call.toolName === "writer_agent")));
});

test("phase lock uses discovered URLs for discovery->fetch handoff when available", () => {
  const urls = Array.from({ length: 24 }, (_, index) => `https://example.com/news/${index + 1}`);
  const progress = {
    successfulToolCalls: 0,
    sourceUrls: new Set<string>([...urls, "not-a-url"]),
    fetchedPageCount: 0,
    draftWordCount: 0,
    citationCount: 0,
    searchTimeoutCount: 0,
    errorSamples: []
  };

  const decision = shouldForcePhaseTransition({
    contract: {
      requiredDeliverable: "Draft",
      requiresDraft: true,
      requiresCitations: true,
      minimumCitationCount: 2,
      doneCriteria: []
    },
    progress,
    actions: [
      { tool: "search", inputJson: "{\"query\":\"ai news\"}" },
      { tool: "search_status", inputJson: "{}" }
    ],
    availableToolNames: new Set(["search", "web_fetch"]),
    objective: "Research top AI news and draft a blog post"
  });

  assert.equal(decision.reason, "phase_lock_forced_transition_discovery_to_fetch");
  assert.ok(Array.isArray(decision.forced));
  assert.equal(decision.forced?.[0]?.tool, "web_fetch");
  const input = JSON.parse(decision.forced?.[0]?.inputJson ?? "{}") as { urls?: string[]; useStoredUrls?: boolean };
  assert.deepEqual(input.urls, urls.slice(0, 12));
  assert.equal(input.useStoredUrls, undefined);
});

test("runSpecialistToolLoop defaults missing single-action input for known tools", async () => {
  const workspace = await createTempWorkspace("specialist-single-input-default");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "Research AI updates", "running");

  const outcome = await runSpecialistToolLoop({
    runStore,
    searchManager: new FakeSearchManagerWithResults() as never,
    workspaceDir: workspace,
    message: "Research AI updates",
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
    maxIterations: 1,
    maxDurationMs: 60_000,
    maxToolCalls: 3,
    maxParallelTools: 1,
    plannerMaxCalls: 2,
    observationWindow: 5,
    diminishingThreshold: 1,
    policyMode: "trusted",
    isCancellationRequested: async () => false,
    skillName: "research_agent",
    skillDescription: "Research skill",
    skillSystemPrompt: "Do research",
    toolAllowlist: ["search"],
    structuredChatRunner: async <T>() =>
      ({
        result: {
          thought: "Search first.",
          actionType: "single",
          singleTool: "search",
          singleInputJson: null,
          parallelActions: null,
          responseText: null
        }
      }) as import("../../src/services/openAiClient.js").StructuredChatDiagnostic<T>
  });

  assert.equal(outcome.status, "completed");
  const updatedRun = await runStore.getRun(run.runId);
  const events = updatedRun ? await runStore.listRunEvents(updatedRun) : [];
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "specialist_plan_adjusted" &&
        (event.payload as { reason?: string }).reason === "single_action_input_defaulted"
    )
  );
  const actionResultEvent = events.find((event) => event.eventType === "specialist_action_result");
  assert.ok(actionResultEvent);
  assert.ok(
    typeof (actionResultEvent?.payload as { actionEconomy?: { efficiency?: number } } | undefined)?.actionEconomy
      ?.efficiency === "number"
  );
});
