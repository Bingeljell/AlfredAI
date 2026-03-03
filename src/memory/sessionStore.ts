import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionRecord } from "../types.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";

const SESSIONS_FILE = "sessions/sessions.json";

export class SessionStore {
  constructor(private readonly workspaceDir: string) {}

  private get filePath(): string {
    return path.join(this.workspaceDir, SESSIONS_FILE);
  }

  private async loadSessions(): Promise<SessionRecord[]> {
    return readJsonFile<SessionRecord[]>(this.filePath, []);
  }

  async createSession(name?: string, metadata?: Record<string, unknown>): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const sessions = await this.loadSessions();
    const session: SessionRecord = {
      id: randomUUID(),
      name: name?.trim() || `Session ${sessions.length + 1}`,
      createdAt: now,
      updatedAt: now,
      status: "active",
      metadata
    };
    sessions.unshift(session);
    await writeJsonFile(this.filePath, sessions);
    return session;
  }

  async listSessions(limit = 50): Promise<SessionRecord[]> {
    const sessions = await this.loadSessions();
    return sessions.slice(0, Math.max(1, limit));
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const sessions = await this.loadSessions();
    return sessions.find((session) => session.id === sessionId);
  }

  async touchSession(sessionId: string): Promise<void> {
    const sessions = await this.loadSessions();
    const index = sessions.findIndex((session) => session.id === sessionId);
    if (index === -1) {
      return;
    }
    sessions[index] = {
      ...sessions[index],
      updatedAt: new Date().toISOString()
    };
    await writeJsonFile(this.filePath, sessions);
  }
}
