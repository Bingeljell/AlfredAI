import test from "node:test";
import assert from "node:assert/strict";
import type { RunEvent, RunRecord } from "../../src/types.js";
import { RunStore } from "../../src/runs/runStore.js";
import type { RunStorage } from "../../src/runs/storage/types.js";

class InMemoryRunStorage implements RunStorage {
  private readonly runs = new Map<string, RunRecord>();
  private readonly events = new Map<string, RunEvent[]>();

  async writeRun(runId: string, run: RunRecord): Promise<void> {
    this.runs.set(runId, structuredClone(run));
  }

  async readRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async listRunIds(): Promise<string[]> {
    return Array.from(this.runs.keys());
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const day = event.timestamp.slice(0, 10);
    const key = `${event.sessionId}:${day}`;
    const items = this.events.get(key) ?? [];
    items.push(structuredClone(event));
    this.events.set(key, items);
  }

  async readSessionDayEvents(sessionId: string, day: string): Promise<RunEvent[]> {
    const key = `${sessionId}:${day}`;
    return structuredClone(this.events.get(key) ?? []);
  }
}

test("RunStore supports pluggable storage adapters", async () => {
  const storage = new InMemoryRunStorage();
  const runStore = new RunStore("/tmp/unused", storage);
  const run = await runStore.createRun("session-1", "hello", "running");

  await runStore.updateRun(run.runId, { status: "completed", assistantText: "done" });
  const loaded = await runStore.getRun(run.runId);

  assert.equal(loaded?.status, "completed");
  assert.equal(loaded?.assistantText, "done");

  const listed = await runStore.listRuns("session-1", 10);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.runId, run.runId);
});

test("RunStore replayLifecycle reconstructs turn lifecycle events", async () => {
  const storage = new InMemoryRunStorage();
  const runStore = new RunStore("/tmp/unused", storage);
  const run = await runStore.createRun("session-1", "hello", "running");

  await runStore.appendEvent({
    runId: run.runId,
    sessionId: "session-1",
    phase: "session",
    eventType: "TurnStarted",
    payload: { op: "UserInput" },
    timestamp: "2026-03-11T10:00:00.000Z"
  });
  await runStore.appendEvent({
    runId: run.runId,
    sessionId: "session-1",
    phase: "session",
    eventType: "TurnProgress",
    payload: { state: "running" },
    timestamp: "2026-03-11T10:00:01.000Z"
  });
  await runStore.appendEvent({
    runId: run.runId,
    sessionId: "session-1",
    phase: "session",
    eventType: "TurnComplete",
    payload: { status: "completed" },
    timestamp: "2026-03-11T10:00:02.000Z"
  });

  const replay = await runStore.replayLifecycle(run.runId);
  assert.equal(replay.startedAt, "2026-03-11T10:00:00.000Z");
  assert.equal(replay.terminalEventType, "TurnComplete");
  assert.equal(replay.progressCount, 1);
  assert.equal(replay.lifecycleEvents.length, 3);
});
