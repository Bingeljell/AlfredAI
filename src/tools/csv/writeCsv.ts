import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { LeadCandidate } from "../../types.js";
import { ensureDir } from "../../utils/fs.js";

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes("\n") || value.includes("\"")) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

export async function writeLeadsCsv(
  workspaceDir: string,
  runId: string,
  candidates: LeadCandidate[]
): Promise<string> {
  const headers = ["companyName", "fullName", "role", "location", "email", "emailConfidence", "sourceUrls", "notes"];
  const rows = candidates.map((candidate) => {
    return [
      candidate.companyName,
      candidate.fullName ?? "",
      candidate.role ?? "",
      candidate.location ?? "",
      candidate.email ?? "",
      String(candidate.emailConfidence),
      candidate.sourceUrls.join(" | "),
      candidate.notes ?? ""
    ];
  });

  const csvBody = [headers, ...rows]
    .map((row) => row.map((cell) => escapeCsv(String(cell))).join(","))
    .join("\n");

  const artifactDir = path.join(workspaceDir, "artifacts", runId);
  await ensureDir(artifactDir);

  const filePath = path.join(artifactDir, "leads.csv");
  await writeFile(filePath, `${csvBody}\n`, "utf8");
  return filePath;
}
