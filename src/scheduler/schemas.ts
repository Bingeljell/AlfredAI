import { z } from "zod";
import {
  SCHEDULER_DEFAULT_MAX_CYCLES,
  SCHEDULER_MAX_CYCLES,
  SCHEDULER_MAX_INSTRUCTION_LENGTH,
  SCHEDULER_MAX_REMINDER_LENGTH,
  SCHEDULER_MIN_INTERVAL_MS,
  SCHEDULER_MIN_DELAY_MS,
  TERMINAL_TASK_STATUSES,
} from "./constants.js";

const Identifier = z.string().trim().min(1).max(256);
const Uuid = z.string().uuid();
const CanonicalUtc = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)),
  "must be a canonical UTC ISO timestamp",
);

export const TaskOwnerSchema = z.object({
  sessionId: Identifier,
  principalId: Identifier,
  channelKey: z.string().trim().min(1).max(512).optional(),
}).strict();

export const NotificationDestinationSchema = z.object({
  channelKey: z.string().trim().min(1).max(512),
  principalId: Identifier,
}).strict();

export const WatchDefinitionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("herdr_agent"),
    workspaceId: Identifier,
    paneId: Identifier,
    agentName: z.string().trim().min(1).max(256).optional(),
  }).strict(),
  z.object({
    type: z.literal("run_status"),
    runId: Identifier,
  }).strict(),
  z.object({
    type: z.literal("file_exists"),
    relativePath: z.string().trim().min(1).max(512).refine((value) => {
      if (value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
      return !value.split(/[\\/]+/).includes("..");
    }, "must be a safe relative path"),
  }).strict(),
]);

export const AgentEventTypeSchema = z.enum(["progress", "completed", "failed", "needs_approval"]);

export const EventMatchSchema = z.object({
  workspaceId: Identifier.optional(),
  paneId: Identifier.optional(),
  agentKind: Identifier.optional(),
  source: Identifier.optional(),
  eventTypes: z.array(AgentEventTypeSchema).min(1).max(4),
}).strict();

const TaskFields = {
  version: z.literal(1),
  id: Uuid,
  label: z.string().trim().min(1).max(256),
  status: z.enum(["pending", "claimed", "running", "completed", "failed", "cancelled", "expired"]),
  owner: TaskOwnerSchema,
  createdByRunId: Identifier,
  createdAt: CanonicalUtc,
  updatedAt: CanonicalUtc,
  dueAt: CanonicalUtc,
  expiresAt: CanonicalUtc.optional(),
  intervalSeconds: z.number().int().positive().optional(),
  intervalMode: z.literal("fixed_delay").optional(),
  maxCycles: z.number().int().min(1).max(SCHEDULER_MAX_CYCLES).default(SCHEDULER_DEFAULT_MAX_CYCLES),
  cycleCount: z.number().int().min(0).max(SCHEDULER_MAX_CYCLES),
  consecutiveFailures: z.number().int().min(0).max(SCHEDULER_MAX_CYCLES),
  instruction: z.string().max(SCHEDULER_MAX_INSTRUCTION_LENGTH).optional(),
  reminderText: z.string().max(SCHEDULER_MAX_REMINDER_LENGTH).optional(),
  watch: WatchDefinitionSchema.optional(),
  eventMatch: EventMatchSchema.optional(),
  activeCycleId: z.string().max(512).optional(),
  activeRunId: Identifier.optional(),
  claimOwner: Identifier.optional(),
  leaseExpiresAt: CanonicalUtc.optional(),
  lastStartedAt: CanonicalUtc.optional(),
  lastCompletedAt: CanonicalUtc.optional(),
  lastErrorCode: z.string().trim().min(1).max(128).optional(),
  lastObservationDigest: z.string().trim().max(256).optional(),
  lastObservationStatus: z.enum(["RUNNING", "TASK_COMPLETE", "IDLE_WAITING_INPUT", "ERROR"]).optional(),
  notificationDestination: NotificationDestinationSchema.optional(),
} as const;

const StoredTaskBase = z.object(TaskFields).strict();

export const ScheduledTaskSchema = z.discriminatedUnion("kind", [
  StoredTaskBase.extend({ kind: z.literal("reminder") }),
  StoredTaskBase.extend({ kind: z.literal("wake_turn") }),
  StoredTaskBase.extend({ kind: z.literal("watch") }),
  StoredTaskBase.extend({ kind: z.literal("event_subscription") }),
]).superRefine((task, context) => {
  if (task.status === "claimed" || task.status === "running") {
    if (!task.activeCycleId || !task.claimOwner || !task.leaseExpiresAt) {
      context.addIssue({ code: "custom", path: ["status"], message: "active tasks require a cycle, claim owner, and lease" });
    }
  }
  if (TERMINAL_TASK_STATUSES.includes(task.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
    for (const field of ["activeCycleId", "activeRunId", "claimOwner", "leaseExpiresAt"] as const) {
      if (task[field] !== undefined) {
        context.addIssue({ code: "custom", path: [field], message: "terminal tasks cannot retain active state" });
      }
    }
  }
  if (task.intervalSeconds !== undefined && task.intervalSeconds * 1_000 < SCHEDULER_MIN_INTERVAL_MS) {
    context.addIssue({ code: "custom", path: ["intervalSeconds"], message: "interval is below the scheduler minimum" });
  }
  if (task.kind === "wake_turn" && !task.instruction) {
    context.addIssue({ code: "custom", path: ["instruction"], message: "wake_turn tasks require an instruction" });
  }
  if (task.kind === "reminder" && !task.reminderText) {
    context.addIssue({ code: "custom", path: ["reminderText"], message: "reminder tasks require reminderText" });
  }
  if (task.kind === "watch" && !task.watch) {
    context.addIssue({ code: "custom", path: ["watch"], message: "watch tasks require a watch definition" });
  }
  if (task.kind === "event_subscription" && !task.eventMatch) {
    context.addIssue({ code: "custom", path: ["eventMatch"], message: "event subscriptions require eventMatch" });
  }
});

const CreateTaskBase = z.object({
  label: z.string().trim().min(1).max(256),
  owner: TaskOwnerSchema,
  createdByRunId: Identifier,
  dueAt: CanonicalUtc,
  expiresAt: CanonicalUtc.optional(),
  intervalSeconds: z.number().int().positive().optional(),
  maxCycles: z.number().int().min(1).max(SCHEDULER_MAX_CYCLES).default(SCHEDULER_DEFAULT_MAX_CYCLES),
  instruction: z.string().trim().min(1).max(SCHEDULER_MAX_INSTRUCTION_LENGTH).optional(),
  reminderText: z.string().trim().min(1).max(SCHEDULER_MAX_REMINDER_LENGTH).optional(),
  watch: WatchDefinitionSchema.optional(),
  eventMatch: EventMatchSchema.optional(),
  notificationDestination: NotificationDestinationSchema.optional(),
}).strict();

export const CreateScheduledTaskSchema = z.discriminatedUnion("kind", [
  CreateTaskBase.extend({ kind: z.literal("reminder") }),
  CreateTaskBase.extend({ kind: z.literal("wake_turn") }),
  CreateTaskBase.extend({ kind: z.literal("watch") }),
  CreateTaskBase.extend({ kind: z.literal("event_subscription") }),
]).superRefine((task, context) => {
  if (task.intervalSeconds !== undefined && task.intervalSeconds * 1_000 < SCHEDULER_MIN_INTERVAL_MS) {
    context.addIssue({ code: "custom", path: ["intervalSeconds"], message: "interval must be at least 60 seconds" });
  }
  if (task.kind === "wake_turn" && !task.instruction) context.addIssue({ code: "custom", path: ["instruction"], message: "wake_turn tasks require an instruction" });
  if (task.kind === "reminder" && !task.reminderText) context.addIssue({ code: "custom", path: ["reminderText"], message: "reminder tasks require reminderText" });
  if (task.kind === "watch" && !task.watch) context.addIssue({ code: "custom", path: ["watch"], message: "watch tasks require a watch definition" });
  if (task.kind === "event_subscription" && !task.eventMatch) context.addIssue({ code: "custom", path: ["eventMatch"], message: "event subscriptions require eventMatch" });
});

export const SchedulerSnapshotSchema = z.object({
  version: z.literal(1),
  tasks: z.array(ScheduledTaskSchema),
}).strict();

export const DeliveryStatusSchema = z.enum(["pending", "sending", "delivered", "failed"]);

export const ScheduledDeliverySchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(768),
  taskId: Uuid,
  cycleId: z.string().min(1).max(512),
  purpose: z.string().trim().min(1).max(128),
  destination: NotificationDestinationSchema,
  status: DeliveryStatusSchema,
  attempts: z.number().int().min(0).max(100),
  createdAt: CanonicalUtc,
  updatedAt: CanonicalUtc,
  sendingAt: CanonicalUtc.optional(),
  deliveredAt: CanonicalUtc.optional(),
  failedAt: CanonicalUtc.optional(),
  safeErrorCode: z.string().trim().min(1).max(128).optional(),
  externalMessageId: z.string().trim().max(256).optional(),
}).strict();

export const DeliverySnapshotSchema = z.object({
  version: z.literal(1),
  deliveries: z.array(ScheduledDeliverySchema),
}).strict();

export const TaskRunEventSchema = z.object({
  version: z.literal(1),
  taskId: Uuid,
  cycleId: z.string().min(1).max(512),
  event: z.enum(["claimed", "started", "completed", "failed", "reconciled"]),
  timestamp: CanonicalUtc,
  runId: Identifier.optional(),
  outcome: z.enum(["success", "retry", "terminal_failure", "cancelled", "expired"]).optional(),
  errorCode: z.string().trim().min(1).max(128).optional(),
  observationDigest: z.string().trim().max(256).optional(),
  attempt: z.number().int().min(0).max(SCHEDULER_MAX_CYCLES).optional(),
}).strict();

export function canonicalUtc(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid timestamp");
  return date.toISOString();
}

export function assertSchedulerDelay(nowMs: number, dueAt: string): void {
  if (Date.parse(dueAt) - nowMs < SCHEDULER_MIN_DELAY_MS) {
    throw new Error("scheduled time must be at least 5 seconds in the future");
  }
}
