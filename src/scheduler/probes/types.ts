import type { WatchDefinition } from "../types.js";

export type ProbeStatus = "pending" | "completed" | "failed" | "missing" | "unknown";
export type WatchSnapshotStatus = "RUNNING" | "TASK_COMPLETE" | "IDLE_WAITING_INPUT" | "ERROR";

export interface WatchSnapshot {
  taskId: string;
  status: WatchSnapshotStatus;
  exitCode: number | null;
  stdout: string[];
}

export interface ProbeResult {
  status: ProbeStatus;
  digest: string;
  summary: string;
  terminal: boolean;
  changed: boolean;
  errorCode?: string;
  snapshot?: WatchSnapshot;
}

export interface SchedulerProbe<T extends WatchDefinition = WatchDefinition> {
  probe(definition: T, previousDigest?: string): Promise<ProbeResult>;
}
