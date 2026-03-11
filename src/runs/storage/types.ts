import type { RunEvent, RunRecord } from "../../types.js";

export interface RunStorage {
  writeRun(runId: string, run: RunRecord): Promise<void>;
  readRun(runId: string): Promise<RunRecord | undefined>;
  listRunIds(): Promise<string[]>;
  appendEvent(event: RunEvent): Promise<void>;
  readSessionDayEvents(sessionId: string, day: string): Promise<RunEvent[]>;
}
