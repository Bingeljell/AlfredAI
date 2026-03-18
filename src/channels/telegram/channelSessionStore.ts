import path from "node:path";
import { readJsonFile, writeJsonFile } from "../../utils/fs.js";
import { ensureDir } from "../../utils/fs.js";

const CHANNEL_SESSIONS_FILE = "sessions/channel-sessions.json";

export interface ChannelSessionRecord {
  sessionId: string;
  label: string | null;
  createdAt: string;
}

type ChannelSessionMap = Record<string, ChannelSessionRecord>;

export class ChannelSessionStore {
  constructor(private readonly workspaceDir: string) {}

  private get filePath(): string {
    return path.join(this.workspaceDir, CHANNEL_SESSIONS_FILE);
  }

  private async load(): Promise<ChannelSessionMap> {
    return readJsonFile<ChannelSessionMap>(this.filePath, {});
  }

  private async save(data: ChannelSessionMap): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeJsonFile(this.filePath, data);
  }

  async get(key: string): Promise<ChannelSessionRecord | undefined> {
    const data = await this.load();
    return data[key];
  }

  async set(key: string, record: ChannelSessionRecord): Promise<void> {
    const data = await this.load();
    data[key] = record;
    await this.save(data);
  }

  async setLabel(key: string, label: string | null): Promise<void> {
    const data = await this.load();
    const existing = data[key];
    if (!existing) return;
    data[key] = { ...existing, label };
    await this.save(data);
  }

  async resetSession(key: string, newSessionId: string): Promise<void> {
    const data = await this.load();
    const existing = data[key];
    if (!existing) return;
    data[key] = {
      sessionId: newSessionId,
      label: existing.label,
      createdAt: new Date().toISOString()
    };
    await this.save(data);
  }
}
