import { readFile, writeFile } from "node:fs/promises";
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
  const headers = [
    "companyName",
    "email",
    "emailEvidence",
    "website",
    "location",
    "employeeSizeText",
    "employeeMin",
    "employeeMax",
    "sizeMatch",
    "sizeEvidence",
    "selectionMode",
    "shortDesc",
    "sourceUrl",
    "confidence",
    "evidence"
  ];
  const rows = candidates.map((candidate) => {
    return [
      candidate.companyName,
      candidate.email ?? "",
      candidate.emailEvidence ?? "",
      candidate.website ?? "",
      candidate.location ?? "",
      candidate.employeeSizeText ?? "",
      candidate.employeeMin ?? "",
      candidate.employeeMax ?? "",
      candidate.sizeMatch ?? "",
      candidate.sizeEvidence ?? "",
      candidate.selectionMode ?? "",
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

/** Parse a CSV row respecting RFC-4180 quoting. */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      // Quoted field
      let field = "";
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ",") i++; // skip comma after quoted field
      else break; // end of line — no more fields
    } else {
      // Unquoted field
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

function strOrUndef(v: string): string | undefined {
  return v === "" ? undefined : v;
}

function numOrUndef(v: string): number | undefined {
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/**
 * Read a leads CSV written by writeLeadsCsv back into LeadCandidate[].
 * Returns [] if the file doesn't exist or can't be parsed.
 */
export async function readLeadsCsv(filePath: string): Promise<LeadCandidate[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return []; // header only or empty

  const leads: LeadCandidate[] = [];
  for (const line of lines.slice(1)) {
    const f = parseCsvRow(line);
    if (f.length < 15) continue;
    const [
      companyName, email, emailEvidence, website, location,
      employeeSizeText, employeeMinStr, employeeMaxStr, sizeMatch,
      sizeEvidence, selectionMode, shortDesc, sourceUrl, confidenceStr, evidence
    ] = f;
    if (!companyName || !shortDesc || !sourceUrl) continue;
    leads.push({
      companyName,
      email: strOrUndef(email),
      emailEvidence: strOrUndef(emailEvidence),
      website: strOrUndef(website),
      location: strOrUndef(location),
      employeeSizeText: strOrUndef(employeeSizeText),
      employeeMin: numOrUndef(employeeMinStr),
      employeeMax: numOrUndef(employeeMaxStr),
      sizeMatch: strOrUndef(sizeMatch) as LeadCandidate["sizeMatch"],
      sizeEvidence: strOrUndef(sizeEvidence),
      selectionMode: strOrUndef(selectionMode) as LeadCandidate["selectionMode"],
      shortDesc,
      sourceUrl,
      confidence: numOrUndef(confidenceStr) ?? 0,
      evidence
    });
  }
  return leads;
}
