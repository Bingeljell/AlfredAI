export const SCHEDULER_SCHEMA_VERSION = 1 as const;
export const SCHEDULER_DIRECTORY = "scheduler";
export const SCHEDULER_TASKS_FILE = "tasks.json";
export const SCHEDULER_LOCK_FILE = "tasks.lock";
export const SCHEDULER_DELIVERIES_LOCK_FILE = "deliveries.lock";
export const SCHEDULER_DELIVERIES_FILE = "deliveries.json";
export const SCHEDULER_TASK_RUNS_DIRECTORY = "task-runs";

export const SCHEDULER_LOCK_TTL_MS = 30_000;
export const SCHEDULER_CLAIM_LEASE_MS = 120_000;
export const SCHEDULER_LEASE_RENEWAL_MS = 30_000;
export const SCHEDULER_MIN_DELAY_MS = 5_000;
export const SCHEDULER_MIN_INTERVAL_MS = 60_000;
export const SCHEDULER_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1_000;
export const SCHEDULER_DEFAULT_WATCH_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const SCHEDULER_MAX_WATCH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
export const SCHEDULER_DEFAULT_MAX_CYCLES = 10;
export const SCHEDULER_MAX_CYCLES = 50;
export const SCHEDULER_MAX_INSTRUCTION_LENGTH = 1_000;
export const SCHEDULER_MAX_REMINDER_LENGTH = 4_000;
export const SCHEDULER_MAX_ACTIVE_TASKS_PER_PRINCIPAL = 20;
export const SCHEDULER_MAX_ACTIVE_TASKS_GLOBAL = 100;
export const SCHEDULER_MAX_CONCURRENCY = 2;
export const SCHEDULER_DEFAULT_TICK_MAX_MS = 15_000;
export const SCHEDULER_DEFAULT_GLOBAL_WAKE_INTERVAL_MS = 30_000;

export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "expired"] as const;
