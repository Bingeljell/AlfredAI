import type { SchedulerProvenance } from "./notifier.js";
import type { EventMatch, ScheduledTaskV1, TaskOwner, WatchDefinition } from "./types.js";

export type SchedulerControlAction =
  | { type: "complete"; summary?: string }
  | { type: "reschedule"; nextDueAt: string; reason?: string };

export interface SchedulerTurnControl {
  readonly taskId: string;
  readonly cycleId: string;
  readonly action?: SchedulerControlAction;
  complete(summary?: string): void;
  reschedule(nextDueAt: string, reason?: string): void;
}

export interface ScheduleTaskRequest {
  kind: "reminder" | "wake_turn" | "watch" | "event_subscription";
  label: string;
  dueAt: string;
  expiresAt?: string;
  intervalSeconds?: number;
  maxCycles?: number;
  instruction?: string;
  reminderText?: string;
  watch?: WatchDefinition;
  eventMatch?: EventMatch;
}

export interface SchedulerTaskApi {
  get(taskId: string): Promise<ScheduledTaskV1 | undefined>;
  attachRun(taskId: string, cycleId: string, runId: string): Promise<ScheduledTaskV1>;
  complete(taskId: string, cycleId: string, nextDueAt?: string, observationDigest?: string, completionSummary?: string): Promise<ScheduledTaskV1>;
  fail(taskId: string, cycleId: string, errorCode: string): Promise<ScheduledTaskV1>;
  schedule(request: ScheduleTaskRequest, provenance: SchedulerProvenance, sessionId: string, createdByRunId: string): Promise<ScheduledTaskV1>;
  list(owner: TaskOwner, includeTerminal?: boolean): Promise<ScheduledTaskV1[]>;
  cancel(taskId: string, owner: TaskOwner): Promise<ScheduledTaskV1>;
}
