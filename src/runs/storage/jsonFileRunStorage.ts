import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RunEvent, RunRecord } from "../../types.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../../utils/fs.js";
import type { RunStorage } from "./types.js";

export class JsonFileRunStorage implements RunStorage {
  constructor(private readonly workspaceDir: string) {}

  private get stateDir(): string {
    return path.join(this.workspaceDir, "runs/state");
  }

  private runStatePath(runId: string): string {
    return path.join(this.stateDir, `${runId}.json`);
  }

  private eventsPath(sessionId: string, day: string): string {
    return path.join(this.workspaceDir, "runs", sessionId, `${day}.jsonl`);
  }

  async writeRun(runId: string, run: RunRecord): Promise<void> {
    await writeJsonFile(this.runStatePath(runId), run);
  }

  async readRun(runId: string): Promise<RunRecord | undefined> {
    return readJsonFile<RunRecord | undefined>(this.runStatePath(runId), undefined);
  }

  async listRunIds(): Promise<string[]> {
    await ensureDir(this.stateDir);
    const files = await readdir(this.stateDir);
    return files
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""));
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const day = event.timestamp.slice(0, 10);
    const filePath = this.eventsPath(event.sessionId, day);
    await ensureDir(path.dirname(filePath));
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async readSessionDayEvents(sessionId: string, day: string): Promise<RunEvent[]> {
    const filePath = this.eventsPath(sessionId, day);
    try {
      const raw = await readFile(filePath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch {
      return [];
    }
  }
}
