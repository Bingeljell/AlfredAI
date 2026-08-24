import { createHash } from "node:crypto";
import type { WatchDefinition } from "../types.js";
import type { ProbeResult, SchedulerProbe } from "./types.js";
import { buildHerdrTerminalSnapshot, type HerdrWatchStatus } from "./herdrTerminalWatcher.js";

export interface HerdrReadOnlyClient {
  getAgentStatus(input: { workspaceId: string; paneId: string; agentName?: string }): Promise<unknown>;
  readPane?(input: { workspaceId: string; paneId: string; agentName?: string }): Promise<unknown>;
}

export class HerdrAgentProbe implements SchedulerProbe<Extract<WatchDefinition, { type: "herdr_agent" }>> {
  constructor(private readonly client: HerdrReadOnlyClient) {}

  async probe(
    definition: Extract<WatchDefinition, { type: "herdr_agent" }>,
    previousDigest?: string,
    taskId = `${definition.workspaceId}:${definition.paneId}`,
  ): Promise<ProbeResult> {
    try {
      const metadata = await this.client.getAgentStatus(definition);
      const output = this.client.readPane ? await this.client.readPane(definition) : metadata;
      const snapshot = buildHerdrTerminalSnapshot(taskId, metadata, output);
      const valueDigest = digest({ status: snapshot.status, exitCode: snapshot.exitCode });
      return {
        status: probeStatus(snapshot.status),
        digest: valueDigest,
        summary: summary(snapshot.status),
        terminal: snapshot.status !== "RUNNING",
        changed: previousDigest !== undefined && previousDigest !== valueDigest,
        snapshot,
      };
    } catch {
      return { status: "unknown", digest: "herdr_probe_error", summary: "The Herdr agent could not be inspected.", terminal: false, changed: false, errorCode: "herdr_probe_error" };
    }
  }
}

function probeStatus(status: HerdrWatchStatus): ProbeResult["status"] {
  if (status === "ERROR") return "failed";
  if (status === "TASK_COMPLETE" || status === "IDLE_WAITING_INPUT") return "completed";
  return "pending";
}

function summary(status: HerdrWatchStatus): string {
  switch (status) {
    case "TASK_COMPLETE": return "The Herdr task completed.";
    case "IDLE_WAITING_INPUT": return "The Herdr agent is idle and waiting for input.";
    case "ERROR": return "The Herdr agent reported an error or exited unsuccessfully.";
    default: return "The Herdr agent is still working.";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}
