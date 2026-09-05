import path from "node:path";
import { readJsonFile, updateJsonFile } from "../../utils/fs.js";

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

  async get(key: string): Promise<ChannelSessionRecord | undefined> {
    const data = await this.load();
    return data[key];
  }

  async set(key: string, record: ChannelSessionRecord): Promise<void> {
    return updateJsonFile<ChannelSessionMap, void>(this.filePath, {}, (data) => {
      data[key] = record;
    });
  }

  async setLabel(key: string, label: string | null): Promise<void> {
    return updateJsonFile<ChannelSessionMap, void>(this.filePath, {}, (data) => {
      const existing = data[key];
      if (!existing) return;
      data[key] = { ...existing, label };
    });
  }

  async resetSession(key: string, newSessionId: string): Promise<void> {
    return updateJsonFile<ChannelSessionMap, void>(this.filePath, {}, (data) => {
      const existing = data[key];
      if (!existing) return;
      data[key] = {
        sessionId: newSessionId,
        label: existing.label,
        createdAt: new Date().toISOString()
      };
    });
  }

  async getAll(): Promise<ChannelSessionMap> {
    return this.load();
  }
}
