import type { WatchDefinition } from "../types.js";

export type ProbeStatus = "pending" | "completed" | "failed" | "missing" | "unknown";

export interface ProbeResult {
  status: ProbeStatus;
  digest: string;
  summary: string;
  terminal: boolean;
  changed: boolean;
  errorCode?: string;
}

export interface SchedulerProbe<T extends WatchDefinition = WatchDefinition> {
  probe(definition: T, previousDigest?: string): Promise<ProbeResult>;
}

