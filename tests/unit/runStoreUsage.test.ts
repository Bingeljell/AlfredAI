import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("runStore accumulates llm usage totals across updates", async () => {
  const workspace = await createTempWorkspace("alfred-runstore-usage");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "find leads", "running");

  await runStore.addLlmUsage(
    run.runId,
    {
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140
    },
    1
  );

  await runStore.addLlmUsage(
    run.runId,
    {
      promptTokens: 60,
      completionTokens: 25,
      totalTokens: 85
    },
    2
  );

  const updated = await runStore.getRun(run.runId);
  assert.ok(updated);
  assert.deepEqual(updated.llmUsage, {
    promptTokens: 160,
    completionTokens: 65,
    totalTokens: 225,
    callCount: 3
  });
});
