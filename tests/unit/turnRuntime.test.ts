import test from "node:test";
import assert from "node:assert/strict";
import { TurnRuntime } from "../../src/core/turnRuntime.js";
import { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("TurnRuntime emits TurnStarted/TurnComplete around UserInput execution", async () => {
  const workspace = await createTempWorkspace("turn-runtime-lifecycle");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "hello", "running");

  const runtime = new TurnRuntime({
    runStore,
    executeUserInput: async () => ({
      status: "completed",
      assistantText: "ok"
    }),
    requestCancellation: async () => {}
  });

  const result = await runtime.dispatch({
    type: "UserInput",
    payload: {
      runId: run.runId,
      sessionId: "session-1",
      message: "hello"
    }
  });

  assert.equal(result.accepted, true);
  assert.equal(result.outcome?.status, "completed");
  assert.equal(result.state, "completed");
  assert.equal(runtime.getState(), "idle");

  const events = await runStore.listRunEvents(run);
  assert.ok(events.some((event) => event.eventType === "TurnStarted"));
  assert.ok(events.some((event) => event.eventType === "TurnComplete"));
});

test("TurnRuntime cancel op requests cancellation and emits TurnAborted", async () => {
  const workspace = await createTempWorkspace("turn-runtime-cancel");
  const runStore = new RunStore(workspace);
  const run = await runStore.createRun("session-1", "cancel me", "running");

  let cancelledRunId: string | null = null;
  const runtime = new TurnRuntime({
    runStore,
    executeUserInput: async () => ({
      status: "completed",
      assistantText: "done"
    }),
    requestCancellation: async (runId) => {
      cancelledRunId = runId;
    }
  });

  const result = await runtime.dispatch({
    type: "Cancel",
    payload: {
      runId: run.runId,
      sessionId: "session-1",
      reason: "api_cancel"
    }
  });

  assert.equal(result.accepted, true);
  assert.equal(cancelledRunId, run.runId);
  const events = await runStore.listRunEvents(run);
  assert.ok(events.some((event) => event.eventType === "TurnAborted"));
});
