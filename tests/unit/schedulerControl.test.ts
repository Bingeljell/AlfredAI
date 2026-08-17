import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerTurnControl } from "../../src/scheduler/execution.js";

test("scheduler terminal control accepts exactly one immutable action", () => {
  const control = createSchedulerTurnControl("550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440000:1");
  control.complete("done");
  assert.deepEqual(control.action, { type: "complete", summary: "done" });
  assert.throws(() => control.reschedule(new Date(Date.now() + 60_000).toISOString()), /already_selected/);
});

