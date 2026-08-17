import { createHash } from "node:crypto";
import type { RunStore } from "../../runs/runStore.js";
import type { WatchDefinition } from "../types.js";
import type { ProbeResult, SchedulerProbe } from "./types.js";

export class RunStatusProbe implements SchedulerProbe<Extract<WatchDefinition, { type: "run_status" }>> {
  constructor(private readonly runStore: RunStore) {}

  async probe(definition: Extract<WatchDefinition, { type: "run_status" }>, previousDigest?: string): Promise<ProbeResult> {
    const run = await this.runStore.getRun(definition.runId);
    if (!run) return result("missing", "run_not_found", "The watched run no longer exists.", true, previousDigest);
    if (run.status === "completed") return result("completed", digest({ status: run.status, assistantText: run.assistantText }), "The watched run completed.", true, previousDigest);
    if (run.status === "failed" || run.status === "cancelled" || run.status === "needs_approval") {
      return result("failed", digest({ status: run.status }), `The watched run is ${run.status}.`, true, previousDigest);
    }
    return result("pending", digest({ status: run.status }), `The watched run is ${run.status}.`, false, previousDigest);
  }
}

function result(status: ProbeResult["status"], valueDigest: string, summary: string, terminal: boolean, previousDigest?: string): ProbeResult {
  return { status, digest: valueDigest, summary, terminal, changed: previousDigest !== undefined && previousDigest !== valueDigest };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

