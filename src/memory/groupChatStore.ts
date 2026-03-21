import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface GroupChatEntry {
  ts: string;
  runId: string;
  sessionId: string;
  role: "user" | "alfred";
  content: string;
  artifacts?: string[];
}

export class GroupChatStore {
  constructor(private readonly workspaceDir: string) {}

  private groupDir(channelKey: string): string {
    // "telegram:1234567890" → "telegram-1234567890"
    return path.join(this.workspaceDir, "groups", channelKey.replace(/[:/]/g, "-"));
  }

  private logPath(channelKey: string, date: string): string {
    const [year, month] = date.split("-");
    return path.join(this.groupDir(channelKey), "logs", year!, month!, `${date}.jsonl`);
  }

  summaryPath(channelKey: string, date: string): string {
    const [year, month] = date.split("-");
    return path.join(this.groupDir(channelKey), "summaries", year!, month!, `${date}.md`);
  }

  private async appendEntry(channelKey: string, entry: GroupChatEntry): Promise<void> {
    const date = entry.ts.slice(0, 10);
    const logPath = this.logPath(channelKey, date);
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
  }

  async appendTurn(
    channelKey: string,
    runId: string,
    sessionId: string,
    userMessage: string,
    alfredResponse: string,
    artifacts: string[] = []
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.appendEntry(channelKey, {
      ts: now,
      runId,
      sessionId,
      role: "user",
      content: userMessage
    });
    await this.appendEntry(channelKey, {
      ts: now,
      runId,
      sessionId,
      role: "alfred",
      content: alfredResponse,
      artifacts: artifacts.length > 0 ? artifacts : undefined
    });
  }
}
