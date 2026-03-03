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
  const headers = ["companyName", "website", "location", "shortDesc", "sourceUrl", "confidence", "evidence"];
  const rows = candidates.map((candidate) => {
    return [
      candidate.companyName,
      candidate.website ?? "",
      candidate.location ?? "",
      candidate.shortDesc,
      candidate.sourceUrl,
      String(candidate.confidence),
      candidate.evidence
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
