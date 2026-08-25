import type { z } from "zod";
import type {
  CreateScheduledTaskSchema,
  DeliverySnapshotSchema,
  ScheduledDeliverySchema,
  EventMatchSchema,
  NotificationDestinationSchema,
  ScheduledTaskSchema,
  SchedulerSnapshotSchema,
  TaskOwnerSchema,
  TaskRunEventSchema,
  WatchDefinitionSchema,
} from "./schemas.js";

export type TaskOwner = z.infer<typeof TaskOwnerSchema>;
export type NotificationDestination = z.infer<typeof NotificationDestinationSchema>;
export type WatchDefinition = z.infer<typeof WatchDefinitionSchema>;
export type EventMatch = z.infer<typeof EventMatchSchema>;
export type ScheduledTaskV1 = z.infer<typeof ScheduledTaskSchema>;
export type CreateScheduledTaskInput = z.input<typeof CreateScheduledTaskSchema>;
export type SchedulerSnapshot = z.infer<typeof SchedulerSnapshotSchema>;
export type ScheduledDeliveryV1 = z.infer<typeof ScheduledDeliverySchema>;
export type DeliverySnapshot = z.infer<typeof DeliverySnapshotSchema>;
export type TaskRunEvent = z.infer<typeof TaskRunEventSchema>;

export type ActiveTaskStatus = Extract<ScheduledTaskV1["status"], "claimed" | "running">;

export type ClaimResult =
  | { claimed: true; task: ScheduledTaskV1; cycleId: string }
  | { claimed: false; reason: "not_found" | "not_due" | "not_pending" | "stale_update" | "expired" | "cycle_limit" };

export interface CompleteCycleInput {
  taskId: string;
  cycleId: string;
  completedAt?: string;
  nextDueAt?: string;
  observationDigest?: string;
  observationStatus?: NonNullable<ScheduledTaskV1["lastObservationStatus"]>;
  errorCode?: string;
  completionSummary?: string;
}

export interface FailCycleInput {
  taskId: string;
  cycleId: string;
  retryAt?: string;
  errorCode: string;
  terminal?: boolean;
}

export type ReconcileInput =
  | { taskId: string; cycleId: string; action: "reclaim"; dueAt: string; errorCode?: string }
  | { taskId: string; cycleId: string; action: "complete"; completedAt?: string; nextDueAt?: string; observationDigest?: string; observationStatus?: NonNullable<ScheduledTaskV1["lastObservationStatus"]> }
  | { taskId: string; cycleId: string; action: "fail"; errorCode: string; retryAt?: string; terminal?: boolean }
  | { taskId: string; action: "expire"; errorCode?: string };
