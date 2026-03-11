import test from "node:test";
import assert from "node:assert/strict";
import { TurnRuntime } from "../../src/core/turnRuntime.js";
import { ThreadRuntime, ThreadRuntimeManager } from "../../src/core/threadRuntime.js";
import { RunStore } from "../../src/runs/runStore.js";
import { InMemoryQueue } from "../../src/workers/inMemoryQueue.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("ThreadRuntime executes queued user-input ops sequentially for one session", async () => {
  const workspace = await createTempWorkspace("thread-runtime-sequential");
  const runStore = new RunStore(workspace);
  const queue = new InMemoryQueue(4);
  const runA = await runStore.createRun("session-1", "first", "running");
  const runB = await runStore.createRun("session-1", "second", "running");

  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const turnRuntime = new TurnRuntime({
    runStore,
    executeUserInput: async (payload) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${payload.message}`);
      await wait(payload.message === "first" ? 25 : 5);
      order.push(`end:${payload.message}`);
      active -= 1;
      return {
        status: "completed",
        assistantText: `${payload.message}:done`
      };
    },
    requestCancellation: async () => {}
  });

  const threadRuntime = new ThreadRuntime({
    sessionId: "session-1",
    queue,
    turnRuntime
  });

  const p1 = threadRuntime.submit({
    type: "UserInput",
    payload: {
      runId: runA.runId,
      sessionId: "session-1",
      message: "first"
    }
  });
  const p2 = threadRuntime.submit({
    type: "UserInput",
    payload: {
      runId: runB.runId,
      sessionId: "session-1",
      message: "second"
    }
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.outcome?.status, "completed");
  assert.equal(r2.outcome?.status, "completed");
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
});

test("ThreadRuntimeManager reuses runtime per session and emits watcher events", async () => {
  const workspace = await createTempWorkspace("thread-runtime-manager");
  const runStore = new RunStore(workspace);
  const queue = new InMemoryQueue(2);
  const run = await runStore.createRun("session-1", "hello", "running");

  const manager = new ThreadRuntimeManager({
    queue,
    createTurnRuntime: () =>
      new TurnRuntime({
        runStore,
        executeUserInput: async () => ({
          status: "completed",
          assistantText: "ok"
        }),
        requestCancellation: async () => {}
      })
  });

  const events: string[] = [];
  const unsubscribe = manager.subscribe("session-1", (event) => {
    events.push(event.type);
  });

  const result = await manager.submit("session-1", {
    type: "UserInput",
    payload: {
      runId: run.runId,
      sessionId: "session-1",
      message: "hello"
    }
  });
  unsubscribe();

  assert.equal(result.outcome?.status, "completed");
  assert.ok(events.includes("op_queued"));
  assert.ok(events.includes("op_started"));
  assert.ok(events.includes("op_completed"));
});
