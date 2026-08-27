import test from "node:test";
import assert from "node:assert/strict";
import { createSchedulerTurnControl } from "../../src/scheduler/execution.js";
import {
  SchedulerTaskCompleteInputSchema,
  toolDefinition as completeTool,
} from "../../src/tools/definitions/schedulerTaskComplete.tool.js";
import {
  SchedulerTaskRescheduleInputSchema,
  toolDefinition as rescheduleTool,
} from "../../src/tools/definitions/schedulerTaskReschedule.tool.js";

test("scheduler terminal control accepts exactly one immutable action", () => {
  const control = createSchedulerTurnControl("550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440000:1");
  control.complete("done");
  assert.deepEqual(control.action, { type: "complete", summary: "done" });
  assert.throws(() => control.reschedule(new Date(Date.now() + 60_000).toISOString()), /already_selected/);
});

test("scheduler terminal tools bind to the server-owned cycle without model-supplied identifiers", async () => {
  const taskId = "550e8400-e29b-41d4-a716-446655440000";
  const cycleId = `${taskId}:7`;
  const completeControl = createSchedulerTurnControl(taskId, cycleId);
  const completeResult = await completeTool.execute(
    { summary: "Observed completion." },
    { schedulerControl: completeControl } as never,
  );

  assert.deepEqual(completeControl.action, { type: "complete", summary: "Observed completion." });
  assert.deepEqual(completeResult, { accepted: true, action: "complete", taskId, cycleId });

  const rescheduleControl = createSchedulerTurnControl(taskId, cycleId);
  const rescheduleResult = await rescheduleTool.execute(
    { delaySeconds: 60, reason: "Still running." },
    { schedulerControl: rescheduleControl } as never,
  );
  assert.equal(rescheduleControl.action?.type, "reschedule");
  assert.deepEqual(
    { ...rescheduleResult, cycleId: rescheduleResult.cycleId },
    { accepted: true, action: "reschedule", taskId, cycleId },
  );

  assert.deepEqual(
    SchedulerTaskCompleteInputSchema.parse({ taskId, cycleId: "cycle-1", summary: "done" }),
    { summary: "done" },
  );
  assert.deepEqual(
    SchedulerTaskRescheduleInputSchema.parse({ taskId, cycleId: "cycle-1", delaySeconds: 60 }),
    { delaySeconds: 60 },
  );
});

test("scheduler terminal tools fail closed outside a scheduler turn", async () => {
  await assert.rejects(
    completeTool.execute({ summary: "done" }, {} as never),
    /scheduler_control_unavailable/,
  );
  await assert.rejects(
    rescheduleTool.execute({ delaySeconds: 60 }, {} as never),
    /scheduler_control_unavailable/,
  );
});
