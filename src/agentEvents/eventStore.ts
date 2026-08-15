/**
 * agentEvents/eventStore — durable append-only log of received agent events.
 *
 * Mirrors the GroupChatStore pattern: one JSONL file per day under
 * `{workspaceDir}/agent-events/YYYY/MM/YYYY-MM-DD.jsonl`. This is the concrete
 * "active job tracking store" the spec refers to — completed/failed/progress
 * transitions are persisted so Alfred can audit or reconcile later.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "./schema.js";

export interface StoredAgentEvent {
  ts: string;
  receivedAt: string;
  event: AgentEvent;
}

export class AgentEventStore {
  constructor(private readonly workspaceDir: string) {}

  private logPath(date: string): string {
    const [year, month] = date.split("-");
    return path.join(this.workspaceDir, "agent-events", year!, month!, `${date}.jsonl`);
  }

  async append(event: AgentEvent): Promise<string> {
    const receivedAt = new Date().toISOString();
    const logPath = this.logPath(receivedAt.slice(0, 10));
    await mkdir(path.dirname(logPath), { recursive: true });
    const entry: StoredAgentEvent = {
      ts: event.timestamp ? new Date(event.timestamp).toISOString() : receivedAt,
      receivedAt,
      event
    };
    await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
    return receivedAt;
  }
}
