import { z } from "zod";
import { extractLead } from "./leadExtractor.tool.js";
import { BrowserPool } from "../browser/browserPool.js";
import type { ToolDefinition } from "../types.js";
import path from "node:path";
import fs from "node:fs/promises";

const LeadGenerationInputSchema = z.object({
  query: z.string().describe("Natural language search query for finding companies (e.g., 'Small MSPs in Austin, TX')"),
  vertical: z.string().describe("Vertical identifier for the CSV file (e.g., 'msp_si', 'wedding_planners')"),
  maxLeads: z.number().int().min(1).max(50).default(10).describe("Number of unique leads to attempt finding"),
  filters: z.string().optional().describe("Additional NL filters (e.g. 'less than 50 employees', 'must have a team page')")
});

async function readExistingLeads(csvPath: string): Promise<Set<string>> {
  try {
    const data = await fs.readFile(csvPath, "utf-8");
    const lines = data.split("\n").slice(1); // skip header
    const urls = new Set<string>();
    for (const line of lines) {
      if (!line.trim()) continue;
      // CSV format: "Company","Contact","Email","URL","Size","Industry","Description"
      // URL is at index 3
      const parts = line.split('","');
      if (parts.length >= 4) {
        const url = parts[3].replace(/"/g, "").trim();
        urls.add(url);
      }
    }
    return urls;
  } catch {
    return new Set();
  }
}

async function appendLeadsToCsv(csvPath: string, leads: any[]) {
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
      (lead.description || "N/A").replace(/"/g, '""') // escape quotes
    ].map(v => `"${v}"`).join(",");
    content += row + "\n";
  }

  await fs.appendFile(csvPath, content, "utf-8");
}

export const toolDefinition: ToolDefinition<typeof LeadGenerationInputSchema> = {
  name: "lead_generation",
  description: "A composite skill that discovers, filters, and extracts leads into a persistent CSV.",
  inputSchema: LeadGenerationInputSchema,
  inputHint: '{"query": "MSPs in Texas", "vertical": "msp_tx", "maxLeads": 5}',
  async execute(input, context) {
    const { query, vertical, maxLeads, filters } = input;
    const csvPath = path.join(context.workspaceDir, `leads_${vertical}.csv`);

    const emitProgress = async (message: string) => {
      await context.runStore.appendEvent({
        runId: context.runId,
        sessionId: context.sessionId,
        phase: "tool",
        eventType: "tool_progress",
        payload: {
          toolName: "lead_generation",
          message,
        },
        timestamp: new Date().toISOString(),
      });
    };
    
    // 1. Get existing leads for deduping
    await emitProgress(`Checking existing leads for vertical: ${vertical}...`);
    const existingUrls = await readExistingLeads(csvPath);
    
    // 2. Search for candidates
    // We search for 2x maxLeads to ensure we have enough after filtering
    await emitProgress(`Searching for ${query}...`);
    const searchResponse = await context.searchManager.search(query, maxLeads * 3);
    const candidateUrls = searchResponse.results
      .map(r => r.url)
      .filter(url => {
        const domain = new URL(url).hostname.toLowerCase();
        // Robust blacklist to avoid directories, junk, and irrelevant sites
        const blacklist = [
          "clutch.co", "yelp.com", "linkedin.com", "facebook.com", "crunchbase.com", 
          "glassdoor.com", "upcity.com", "designrush.com", "cloudtango.org", "cloudtango.net",
          "mspdatabase.com", "tceq.texas.gov", "texas.gov", "wikipedia.org", "youtube.com",
          "instagram.com", "twitter.com", "reddit.com", "quora.com", "business.site",
          "infomsp.com", "palisade.email", "trgdatacenters.com"
        ];
        return !blacklist.some(b => domain.includes(b)) && 
               !domain.endsWith(".gov") && 
               !domain.endsWith(".edu") && 
               !existingUrls.has(url);
      });

    await emitProgress(`Found ${candidateUrls.length} new candidates. Starting deep extraction...`);
    const newLeads: any[] = [];
    let processedCount = 0;
    const totalUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      callCount: 0
    };

    const mergeUsage = (current?: any) => {
      if (!current) return;
      totalUsage.promptTokens += current.promptTokens || 0;
      totalUsage.completionTokens += current.completionTokens || 0;
      totalUsage.totalTokens += current.totalTokens || 0;
      totalUsage.cachedTokens += current.cachedTokens || 0;
      totalUsage.callCount += current.callCount || 1;
    };

    const browserPool = await BrowserPool.create();
    try {
      for (const url of candidateUrls) {
        if (newLeads.length >= maxLeads) break;
        // 45s safety buffer to ensure we can save results before the turn hard timeout
        if (Date.now() >= context.deadlineAtMs - 45000) {
          await emitProgress("Approaching turn deadline. Saving current progress and finishing...");
          break;
        }

        processedCount++;
        const domain = new URL(url).hostname;
        await emitProgress(`[${newLeads.length}/${maxLeads}] Deep extracting ${domain}...`);
        
        try {
          // Delay to avoid bot bans (e.g. 2s)
          await new Promise(r => setTimeout(r, 2000));

          const result = await extractLead(url, true, context, browserPool);
          mergeUsage(result.usage);
          
          if (result.emails && (result.emails as string[]).length > 0) {
              // Check filters if provided
              if (filters && context.llmProviders && context.llmProviders.length > 0) {
                  await emitProgress(`Filtering ${result.companyName}...`);
                  const llm = context.llmProviders[0];
                  const filterCheck = await llm.generateText({
                      messages: [
                          {
                              role: "system",
                              content: `Evaluate if this company lead matches the following criteria: ${filters}. Respond ONLY with 'YES' or 'NO'.`
                          },
                          {
                              role: "user",
                              content: `Company: ${result.companyName}\nIndustry: ${result.industry}\nSize: ${result.companySize}\nDescription: ${result.description}`
                          }
                      ]
                  });
                  mergeUsage(filterCheck.usage);
                  if (filterCheck.content?.trim().toUpperCase().includes("NO")) {
                      continue;
                  }
              }
              newLeads.push(result);
              await emitProgress(`Extracted lead for ${result.companyName}.`);
          }
        } catch (err) {
          console.error(`Failed to extract ${url}:`, err);
        }
      }
    } finally {
      await browserPool.close();
    }

    if (newLeads.length > 0) {
      await emitProgress(`Updating ${vertical} ledger with ${newLeads.length} new leads.`);
      await appendLeadsToCsv(csvPath, newLeads);
    }

    return {
      status: "success",
      leadsFound: newLeads.length,
      leadsProcessed: processedCount,
      totalLeadsInCsv: existingUrls.size + newLeads.length,
      csvPath: csvPath,
      newLeads: newLeads.map(l => ({ name: l.companyName, email: l.emails[0], url: l.sourceUrl })),
      usage: totalUsage
    };
  }
};
