import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/memory/sessionStore.js";
import { RunStore } from "../../src/runs/runStore.js";
import { ChatService } from "../../src/runner/chatService.js";
import { SchedulerDeliveryStore } from "../../src/scheduler/deliveryStore.js";
import { SchedulerEngine } from "../../src/scheduler/engine.js";
import { SchedulerTaskRunLog } from "../../src/scheduler/taskRunLog.js";
import { SchedulerTaskStore } from "../../src/scheduler/taskStore.js";
import type { SchedulerClock } from "../../src/scheduler/clock.js";
import { InMemoryQueue } from "../../src/workers/inMemoryQueue.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class FakeClock implements SchedulerClock {
  now = Date.parse("2026-08-17T10:00:00.000Z");
  nowMs(): number { return this.now; }
  setTimeout(_callback: () => void): ReturnType<typeof setTimeout> {
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(): void {}
}

test("scheduled wake reuses task/cycle identity and avoids interactive memory persistence", async () => {
  const workspace = await createTempWorkspace("scheduler-wake-turn");
  const clock = new FakeClock();
  const sessionStore = new SessionStore(workspace);
  const session = await sessionStore.createSession("Scheduler");
  const runStore = new RunStore(workspace);
  const taskStore = new SchedulerTaskStore({ workspaceDir: workspace, nowMs: () => clock.nowMs(), instanceId: "wake-task" });
  const deliveryStore = new SchedulerDeliveryStore({ workspaceDir: workspace, nowMs: () => clock.nowMs(), instanceId: "wake-delivery" });
  await taskStore.init();
  await deliveryStore.init();

  let capturedProfile: { origin?: string; maxIterations?: number; maxToolCalls?: number; persistConversation?: boolean } | undefined;
  let service!: ChatService;
  const engine = new SchedulerEngine({
    taskStore,
    deliveryStore,
    taskRunLog: new SchedulerTaskRunLog(workspace),
    clock,
    executeWake: async (task, cycleId) => {
      await service.handleScheduledTurn({
        taskId: task.id,
        cycleId,
        sessionId: task.owner.sessionId,
        instruction: task.instruction ?? "Check",
        owner: { principalId: task.owner.principalId, channelKey: task.owner.channelKey, origin: "scheduler" },
      });
      return (await taskStore.get(task.id)) ?? task;
    },
  });
  service = new ChatService({
    sessionStore,
    runStore,
    searchManager: {} as never,
    queue: new InMemoryQueue(1),
    workspaceDir: workspace,
    searchMaxResults: 10,
    fastScrapeCount: 1,
    enablePlaywright: false,
    maxSteps: 6,
    browseConcurrency: 1,
    agentMaxDurationMs: 600_000,
    agentMaxToolCalls: 18,
    agentMaxParallelTools: 3,
    scheduler: engine,
    runLoopRunner: async (_sessionId, _message, _runId, options) => {
      capturedProfile = options.executionProfile;
      options.schedulerControl?.complete("Condition satisfied");
      return { status: "completed", assistantText: "completed" };
    },
  });

  const task = await taskStore.create({
    kind: "wake_turn",
    label: "check",
    owner: { sessionId: session.id, principalId: "api", channelKey: "web:" + session.id },
    createdByRunId: "interactive-run",
    dueAt: "2026-08-17T10:00:05.000Z",
    instruction: "Check the deployment",
  });
  await engine.start();
  clock.now += 5_000;
  await engine.tick();
  await engine.stop();

  const completed = await taskStore.get(task.id);
  assert.equal(completed?.status, "completed");
  assert.equal(capturedProfile?.origin, "scheduler");
  assert.equal(capturedProfile?.maxIterations, 5);
  assert.equal(capturedProfile?.maxToolCalls, 5);
  assert.equal(capturedProfile?.persistConversation, false);
  const runs = await runStore.listRuns(session.id, 10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.scheduler?.taskId, task.id);
  assert.equal((await sessionStore.getSession(session.id))?.workingMemory, undefined);
});
