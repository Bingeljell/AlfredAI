import fs from "node:fs/promises";
import { normalizeDomain } from "./leadScoring.js";

export interface PersistedLeadLike {
  companyName?: string;
  contactName?: string;
  emails?: string[];
  sourceUrl?: string;
  companySize?: string;
  industry?: string;
  description?: string;
  normalizedDomain?: string | null;
  discoveryProfile?: string;
  discoveryCountry?: string;
  discoveryScore?: number;
  discoveryReasons?: string[];
}

function escapeCsvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function readExistingLeadDomains(csvPath: string): Promise<Set<string>> {
  try {
    const data = await fs.readFile(csvPath, "utf-8");
    const domains = new Set<string>();

    for (const line of data.split("\n").slice(1)) {
      if (!line.trim()) {
        continue;
      }
      const parts = line.split('","');
      if (parts.length < 4) {
        continue;
      }
      const url = parts[3].replace(/"/g, "").trim();
      const domain = normalizeDomain(url);
      if (domain) {
        domains.add(domain);
      }
    }

    return domains;
  } catch {
    return new Set();
  }
}

export async function appendLeadsToCsv(csvPath: string, leads: PersistedLeadLike[]): Promise<void> {
  const header = "Company Name,Contact Name,Email,Source URL,Size,Industry,Description\n";
  const fileExists = await fs.access(csvPath).then(() => true).catch(() => false);

  let content = "";
  if (!fileExists) {
    content += header;
  }

  for (const lead of leads) {
    const row = [
      lead.companyName || "N/A",
      lead.contactName || "N/A",
      (lead.emails || []).join("; "),
      lead.sourceUrl || "N/A",
      lead.companySize || "N/A",
      lead.industry || "N/A",
      lead.description || "N/A"
    ].map(escapeCsvCell).join(",");
    content += `${row}\n`;
  }

  await fs.appendFile(csvPath, content, "utf-8");
}

export async function appendExperimentLedger(
  ledgerPath: string,
  leads: PersistedLeadLike[]
): Promise<void> {
  const existing: PersistedLeadLike[] = await fs.readFile(ledgerPath, "utf-8")
    .then((data) => JSON.parse(data) as PersistedLeadLike[])
    .catch(() => []);

  existing.push(
    ...leads.map((lead) => ({
      companyName: lead.companyName,
      normalizedDomain: lead.normalizedDomain ?? normalizeDomain(lead.sourceUrl || ""),
      sourceUrl: lead.sourceUrl,
      emails: lead.emails,
      industry: lead.industry,
      companySize: lead.companySize,
      description: lead.description,
      discoveryProfile: lead.discoveryProfile,
      discoveryCountry: lead.discoveryCountry,
      discoveryScore: lead.discoveryScore,
      discoveryReasons: lead.discoveryReasons,
      createdAt: new Date().toISOString()
    }))
  );

  await fs.writeFile(ledgerPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
}
