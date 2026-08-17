import { createHash } from "node:crypto";
import type { WatchDefinition } from "../types.js";
import type { ProbeResult, SchedulerProbe } from "./types.js";

export interface HerdrReadOnlyClient {
  getAgentStatus(input: { workspaceId: string; paneId: string; agentName?: string }): Promise<unknown>;
}

export class HerdrAgentProbe implements SchedulerProbe<Extract<WatchDefinition, { type: "herdr_agent" }>> {
  constructor(private readonly client: HerdrReadOnlyClient) {}

  async probe(definition: Extract<WatchDefinition, { type: "herdr_agent" }>, previousDigest?: string): Promise<ProbeResult> {
    try {
      const value = await this.client.getAgentStatus(definition);
      const state = classify(value);
      const valueDigest = digest({ state, value });
      return {
        status: state.status,
        digest: valueDigest,
        summary: state.summary,
        terminal: state.terminal,
        changed: previousDigest !== undefined && previousDigest !== valueDigest,
      };
    } catch {
      return { status: "unknown", digest: "herdr_probe_error", summary: "The Herdr agent could not be inspected.", terminal: false, changed: false, errorCode: "herdr_probe_error" };
    }
  }
}

function classify(value: unknown): { status: ProbeResult["status"]; summary: string; terminal: boolean } {
  const text = JSON.stringify(value).toLowerCase();
  if (/(failed|error|crashed|exited)/.test(text)) return { status: "failed", summary: "The Herdr agent failed or exited.", terminal: true };
  if (/(completed|complete|done|finished|success)/.test(text)) return { status: "completed", summary: "The Herdr agent completed.", terminal: true };
  if (/(missing|not found|unknown)/.test(text)) return { status: "missing", summary: "The Herdr agent or pane is missing.", terminal: true };
  return { status: "pending", summary: "The Herdr agent is still active.", terminal: false };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

