import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionRecord, SessionWorkingMemory } from "../types.js";
import { readJsonFile, updateJsonFile } from "../utils/fs.js";

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
    return updateJsonFile<SessionRecord[], SessionRecord>(this.filePath, [], (sessions) => {
      const session: SessionRecord = {
        id: randomUUID(),
        name: name?.trim() || `Session ${sessions.length + 1}`,
        createdAt: now,
        updatedAt: now,
        status: "active",
        metadata
      };
      sessions.unshift(session);
      return session;
    });
  }

  async listSessions(limit = 50): Promise<SessionRecord[]> {
    const sessions = await this.loadSessions();
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(1, limit));
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const sessions = await this.loadSessions();
    return sessions.find((session) => session.id === sessionId);
  }

  async touchSession(sessionId: string): Promise<void> {
    return updateJsonFile<SessionRecord[], void>(this.filePath, [], (sessions) => {
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index === -1) {
        return;
      }
      sessions[index] = {
        ...sessions[index],
        updatedAt: new Date().toISOString()
      };
    });
  }

  async updateWorkingMemory(sessionId: string, patch: Partial<SessionWorkingMemory>): Promise<SessionRecord | undefined> {
    return updateJsonFile<SessionRecord[], SessionRecord | undefined>(this.filePath, [], (sessions) => {
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index === -1) {
        return undefined;
      }

      const updated: SessionRecord = {
        ...sessions[index],
        updatedAt: new Date().toISOString(),
        workingMemory: {
          ...(sessions[index]?.workingMemory ?? {}),
          ...patch
        }
      };
      sessions[index] = updated;
      return updated;
    });
  }

  async setPreferences(sessionId: string, preferences?: SessionRecord["preferences"]): Promise<SessionRecord | undefined> {
    return updateJsonFile<SessionRecord[], SessionRecord | undefined>(this.filePath, [], (sessions) => {
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index === -1) return undefined;
      const compactPreferences = preferences
        ? Object.fromEntries(Object.entries(preferences).filter(([, value]) => typeof value === "string" && value.length > 0))
        : undefined;
      const updated: SessionRecord = {
        ...sessions[index],
        updatedAt: new Date().toISOString(),
        preferences: compactPreferences && Object.keys(compactPreferences).length > 0 ? compactPreferences : undefined
      };
      sessions[index] = updated;
      return updated;
    });
  }

  async resetWorkingMemory(sessionId: string): Promise<SessionRecord | undefined> {
    return updateJsonFile<SessionRecord[], SessionRecord | undefined>(this.filePath, [], (sessions) => {
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index === -1) {
        return undefined;
      }

      const updated: SessionRecord = {
        ...sessions[index],
        updatedAt: new Date().toISOString(),
        preferences: undefined,
        workingMemory: undefined
      };
      sessions[index] = updated;
      return updated;
    });
  }
}
