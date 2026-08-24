import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrReadOnlyClient } from "./herdrAgentProbe.js";
import { HERDR_SNAPSHOT_LINE_LIMIT } from "./herdrTerminalWatcher.js";

const execFileAsync = promisify(execFile);

export class DefaultHerdrReadOnlyClient implements HerdrReadOnlyClient {
  async getAgentStatus(input: { workspaceId: string; paneId: string; agentName?: string }): Promise<unknown> {
    const target = input.agentName ?? input.paneId;
    const result = await execFileAsync("herdr", ["agent", "get", target], { timeout: 10_000, maxBuffer: 512 * 1024 });
    const raw = String(result.stdout ?? "").trim();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    return { workspaceId: input.workspaceId, paneId: input.paneId, agentName: input.agentName, agents: value };
  }

  async readPane(input: { workspaceId: string; paneId: string; agentName?: string }): Promise<string> {
    const target = input.agentName ?? input.paneId;
    const result = await execFileAsync(
      "herdr",
      ["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(HERDR_SNAPSHOT_LINE_LIMIT), "--format", "text"],
      { timeout: 10_000, maxBuffer: 512 * 1024 },
    );
    return String(result.stdout ?? "");
  }
}
