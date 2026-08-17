import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrReadOnlyClient } from "./herdrAgentProbe.js";

const execFileAsync = promisify(execFile);

export class DefaultHerdrReadOnlyClient implements HerdrReadOnlyClient {
  async getAgentStatus(input: { workspaceId: string; paneId: string; agentName?: string }): Promise<unknown> {
    const result = await execFileAsync("herdr", ["agent", "list"], { timeout: 10_000, maxBuffer: 512 * 1024 });
    const raw = String(result.stdout ?? "").trim();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    return { workspaceId: input.workspaceId, paneId: input.paneId, agentName: input.agentName, agents: value };
  }
}

