import test from "node:test";
import assert from "node:assert/strict";
import { ScheduleReminderInputSchema, toolDefinition as reminderTool } from "../../src/tools/definitions/scheduleReminder.tool.js";
import { ScheduleWakeInputSchema, toolDefinition as wakeTool } from "../../src/tools/definitions/scheduleWake.tool.js";
import type { SchedulerTaskApi, ScheduleTaskRequest } from "../../src/scheduler/api.js";
import type { SchedulerProvenance } from "../../src/scheduler/notifier.js";
import type { ScheduledTaskV1, TaskOwner } from "../../src/scheduler/types.js";
import type { ToolContext } from "../../src/tools/types.js";

class FakeScheduler implements SchedulerTaskApi {
  requests: ScheduleTaskRequest[] = [];
  async get(): Promise<ScheduledTaskV1 | undefined> { return undefined; }
  async attachRun(): Promise<ScheduledTaskV1> { throw new Error("not used"); }
  async complete(): Promise<ScheduledTaskV1> { throw new Error("not used"); }
  async fail(): Promise<ScheduledTaskV1> { throw new Error("not used"); }
  async schedule(request: ScheduleTaskRequest, _provenance: SchedulerProvenance, _sessionId: string, _runId: string): Promise<ScheduledTaskV1> {
    this.requests.push(request);
    return {
      version: 1,
      id: "550e8400-e29b-41d4-a716-446655440000",
      ...request,
      status: "pending",
      owner: { sessionId: "session-1", principalId: "principal-1" },
      createdByRunId: "run-1",
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
      cycleCount: 0,
      consecutiveFailures: 0,
    } as ScheduledTaskV1;
  }
  async list(_owner: TaskOwner): Promise<ScheduledTaskV1[]> { return []; }
  async cancel(): Promise<ScheduledTaskV1> { throw new Error("not used"); }
}

function context(scheduler?: SchedulerTaskApi): ToolContext {
  return {
    runId: "run-1",
    sessionId: "session-1",
    message: "schedule it",
    deadlineAtMs: Date.now() + 60_000,
    policyMode: "trusted",
    projectRoot: process.cwd(),
    runStore: undefined as never,
    searchManager: undefined as never,
    workspaceDir: "/tmp/workspace",
    defaults: { searchMaxResults: 10, browseConcurrency: 1 },
    state: { artifacts: [], fetchedPages: [] },
    isCancellationRequested: async () => false,
    addArtifact: () => {},
    setFetchedPages: () => {},
    getFetchedPages: () => [],
    scheduler,
    provenance: { principalId: "principal-1", channelKey: "web:session-1", origin: "web" },
  };
}

test("schedule tools derive ownership and canonical UTC due times", async () => {
  const scheduler = new FakeScheduler();
  const before = Date.now();
  const reminderInput = ScheduleReminderInputSchema.parse({ reminderText: "Call Alice", delaySeconds: 5 });
  const wakeInput = ScheduleWakeInputSchema.parse({ instruction: "Check the deployment", runAt: "2026-08-17T13:00:00+02:00" });
  await reminderTool.execute(reminderInput, context(scheduler));
  await wakeTool.execute(wakeInput, context(scheduler));
  const dueAtMs = Date.parse(scheduler.requests[0]?.dueAt ?? "");
  assert.ok(dueAtMs >= before + 5_000 && dueAtMs <= Date.now() + 5_250);
  assert.equal(scheduler.requests[1]?.dueAt, "2026-08-17T11:00:00.000Z");
  assert.equal(scheduler.requests[0]?.kind, "reminder");
  assert.equal(scheduler.requests[1]?.kind, "wake_turn");
});

test("schedule time requires exactly one delay or timezone-qualified runAt", () => {
  assert.throws(() => ScheduleWakeInputSchema.parse({ instruction: "x", delaySeconds: 5, runAt: "2026-08-17T10:00:00Z" }));
  assert.throws(() => ScheduleWakeInputSchema.parse({ instruction: "x", runAt: "2026-08-17T10:00:00" }));
});

test("scheduler tools fail closed when invoked without scheduler provenance", async () => {
  const input = ScheduleReminderInputSchema.parse({ reminderText: "x", delaySeconds: 5 });
  await assert.rejects(() => reminderTool.execute(input, context()), /scheduler_disabled/);
});
