import test from "node:test";
import assert from "node:assert/strict";
import { CreateScheduledTaskSchema, ScheduledTaskSchema, WatchDefinitionSchema } from "../../src/scheduler/schemas.js";

const base = {
  label: "check later",
  owner: { sessionId: "session-1", principalId: "principal-1" },
  createdByRunId: "run-1",
  dueAt: "2026-08-17T12:00:10.000Z",
};

test("scheduler schemas enforce exact task shapes and required kind fields", () => {
  const parsed = CreateScheduledTaskSchema.parse({
    ...base,
    kind: "wake_turn",
    instruction: "Review the pending work",
  });
  assert.equal(parsed.kind, "wake_turn");

  assert.throws(() => CreateScheduledTaskSchema.parse({ ...base, kind: "wake_turn" }));
  assert.throws(() => CreateScheduledTaskSchema.parse({ ...base, kind: "reminder", reminderText: "x", unknown: true }));
  assert.throws(() => WatchDefinitionSchema.parse({ type: "file_exists", relativePath: "../secret.txt" }));
  assert.throws(() => WatchDefinitionSchema.parse({ type: "file_exists", relativePath: "/tmp/secret.txt" }));
});

test("stored terminal tasks cannot retain a lease", () => {
  assert.throws(() => ScheduledTaskSchema.parse({
    version: 1,
    id: "550e8400-e29b-41d4-a716-446655440000",
    label: "done",
    kind: "reminder",
    status: "completed",
    owner: { sessionId: "session-1", principalId: "principal-1" },
    createdByRunId: "run-1",
    createdAt: "2026-08-17T11:00:00.000Z",
    updatedAt: "2026-08-17T11:00:00.000Z",
    dueAt: "2026-08-17T12:00:00.000Z",
    reminderText: "done",
    cycleCount: 1,
    consecutiveFailures: 0,
    leaseExpiresAt: "2026-08-17T12:02:00.000Z",
  }));
});

