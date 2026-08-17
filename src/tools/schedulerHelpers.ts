import { z } from "zod";
import { canonicalUtc } from "../scheduler/schemas.js";

export const DelayOrRunAtSchema = z.object({
  delaySeconds: z.number().int().min(5).max(365 * 24 * 60 * 60).optional(),
  runAt: z.string().min(1).max(64).optional(),
}).strict().superRefine((value, context) => {
  if ((value.delaySeconds === undefined) === (value.runAt === undefined)) {
    context.addIssue({ code: "custom", path: ["delaySeconds"], message: "provide exactly one of delaySeconds or runAt" });
  }
  if (value.runAt !== undefined && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value.runAt)) {
    context.addIssue({ code: "custom", path: ["runAt"], message: "runAt must include a timezone offset or Z" });
  }
});

export function validateDelayOrRunAt(value: { delaySeconds?: number; runAt?: string }, context: z.RefinementCtx): void {
  if ((value.delaySeconds === undefined) === (value.runAt === undefined)) {
    context.addIssue({ code: "custom", path: ["delaySeconds"], message: "provide exactly one of delaySeconds or runAt" });
  }
  if (value.runAt !== undefined && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value.runAt)) {
    context.addIssue({ code: "custom", path: ["runAt"], message: "runAt must include a timezone offset or Z" });
  }
}

export function resolveDueAt(input: { delaySeconds?: number; runAt?: string }, nowMs = Date.now()): string {
  if (input.delaySeconds !== undefined) return canonicalUtc(nowMs + input.delaySeconds * 1_000 + 250);
  if (!input.runAt) throw new Error("missing_schedule_time");
  const timestamp = Date.parse(input.runAt);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_run_at");
  return canonicalUtc(timestamp);
}

export function requireScheduler(context: { scheduler?: unknown; provenance?: unknown }): asserts context is { scheduler: NonNullable<typeof context.scheduler>; provenance: NonNullable<typeof context.provenance> } {
  if (!context.scheduler || !context.provenance) throw new Error("scheduler_disabled");
}
