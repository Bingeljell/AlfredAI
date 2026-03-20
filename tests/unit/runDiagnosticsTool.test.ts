import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { RunStore } from "../../src/runs/runStore.js";
import { toolDefinition as runDiagnosticsTool } from "../../src/tools/definitions/runDiagnostics.tool.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

function buildToolContext(workspace: string, runStore: RunStore) {
  return {
    runId: "context-run",
    sessionId: "session-1",
    message: "diagnostics test",
    deadlineAtMs: Date.now() + 60_000,
    policyMode: "trusted" as const,
    projectRoot: workspace,
    runStore,
    searchManager: {} as never,
    workspaceDir: workspace,
    openAiApiKey: undefined,
    defaults: {
      searchMaxResults: 15,
      browseConcurrency: 3
    },
    leadPipelineExecutor: (async () => {
      throw new Error("not used");
    }) as never,
    state: {
      leads: [],
      artifacts: [],
      requestedLeadCount: 0,
      fetchedPages: []
    },
    isCancellationRequested: async () => false,
    addLeads: () => ({ addedCount: 0, totalCount: 0 }),
    addArtifact: () => undefined,
    setFetchedPages: () => undefined,
    getFetchedPages: () => []
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

test("run_diagnostics summarizes failure signals from run store", async () => {
  const workspace = await createTempWorkspace("alfred-run-diagnostics");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "find leads", "running");

  await runStore.addToolCall(run.runId, {
    toolName: "search",
    inputRedacted: { query: "test" },
    outputRedacted: { error: "provider timeout" },
    durationMs: 220,
    status: "error",
    timestamp: nowIso()
  });
  await runStore.appendEvent({
    runId: run.runId,
    sessionId: run.sessionId,
    phase: "observe",
    eventType: "agent_action_result",
    payload: {
      searchFailureCount: 2,
      browseFailureCount: 1,
      extractionFailureCount: 0,
      semanticMissCount: 1,
      retrievalBlockedCount: 0,
      hadLlmBudgetExhausted: false
    },
    timestamp: nowIso()
  });
  await runStore.appendEvent({
    runId: run.runId,
    sessionId: run.sessionId,
    phase: "final",
    eventType: "agent_stop",
    payload: {
      reason: "budget_exhausted",
      explanation: "ran out of time"
    },
    timestamp: nowIso()
  });
  await runStore.appendEvent({
    runId: run.runId,
    sessionId: run.sessionId,
    phase: "final",
    eventType: "final_answer",
    payload: {
      candidateCount: 0
    },
    timestamp: nowIso()
  });

  const output = await runDiagnosticsTool.execute(
    {
      runId: run.runId
    },
    buildToolContext(workspace, runStore)
  );

  assert.equal(output.sourceType, "run_store");
  assert.equal((output.counts as { errorToolCallCount: number }).errorToolCallCount, 1);
  assert.equal((output.failureSignals as { searchFailureCount: number }).searchFailureCount, 2);
  assert.ok(
    ((output.recommendations as string[]) ?? []).some((item) => item.includes("Search failures detected")),
    "expected search-failure recommendation"
  );
});

test("run_diagnostics reads debug export path", async () => {
  const workspace = await createTempWorkspace("alfred-run-diagnostics-export");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "find leads", "completed");

  await runStore.appendEvent({
    runId: run.runId,
    sessionId: run.sessionId,
    phase: "final",
    eventType: "final_answer",
    payload: { candidateCount: 1 },
    timestamp: nowIso()
  });
  const debugExport = await runStore.buildDebugExport(run.runId);
  const debugPath = path.join(workspace, "debug-export.json");
  await writeFile(debugPath, JSON.stringify(debugExport), "utf8");

  const output = await runDiagnosticsTool.execute(
    {
      debugExportPath: "debug-export.json"
    },
    buildToolContext(workspace, runStore)
  );

  assert.equal(output.sourceType, "debug_export");
  assert.equal((output.counts as { finalAnswerEventCount: number }).finalAnswerEventCount, 1);
  assert.equal((output.run as { runId: string }).runId, run.runId);
});
