import path from "node:path";
import { readJsonFile, updateJsonFile } from "../utils/fs.js";

/** Explicit owner links. Conversation attachment alone never merges identities. */
export class IdentityStore {
  private readonly filePath: string;
  constructor(workspaceDir: string) { this.filePath = path.join(workspaceDir, "sessions/identity-links.json"); }

  async linkTelegram(userId: string): Promise<void> {
    if (!/^\d+$/.test(userId)) throw new Error("invalid_telegram_user");
    await updateJsonFile<string[], void>(this.filePath, [], (ids) => { if (!ids.includes(userId)) ids.push(userId); });
  }

  async aliases(principalId: string): Promise<string[]> {
    const ids = await readJsonFile<string[]>(this.filePath, []);
    return principalId === "api" || ids.includes(principalId) ? ["api", ...ids] : [principalId];
  }

  async unlinkTelegram(userId: string): Promise<void> {
    await updateJsonFile<string[], void>(this.filePath, [], (ids) => {
      const index = ids.indexOf(userId);
      if (index >= 0) ids.splice(index, 1);
    });
  }
}
