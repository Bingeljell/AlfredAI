export type TurnOrigin = "interactive" | "scheduler";

export interface TurnExecutionProfile {
  origin: TurnOrigin;
  maxIterations: number;
  maxToolCalls: number;
  maxDurationMs: number;
  toolAllowlist: string[];
  persistConversation: boolean;
  taskId?: string;
  cycleId?: string;
}

export const SCHEDULER_EXECUTION_PROFILE = {
  origin: "scheduler",
  maxIterations: 5,
  maxToolCalls: 5,
  maxDurationMs: 60_000,
  persistConversation: false,
  toolAllowlist: ["scheduler_task_complete", "scheduler_task_reschedule", "run_status", "file_exists", "herdr_status"],
} as const;

