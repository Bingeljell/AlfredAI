import { appendFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../utils/fs.js";

function getDateParts(now: Date): { year: string; month: string; day: string } {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return { year, month, day };
}

export async function appendDailyNote(
  workspaceDir: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const now = new Date();
  const { year, month, day } = getDateParts(now);
  const filePath = path.join(workspaceDir, "knowledge", "Daily", year, month, `${day}.md`);

  await ensureDir(path.dirname(filePath));

  const line = `- ${now.toISOString()} | ${sessionId} | ${role}: ${content.replace(/\n+/g, " ").slice(0, 2000)}\n`;
  await appendFile(filePath, line, "utf8");
}
