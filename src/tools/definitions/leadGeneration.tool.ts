import { z } from "zod";
import { extractLead } from "./leadExtractor.tool.js";
import { BrowserPool } from "../browser/browserPool.js";
import type { ToolDefinition } from "../types.js";
import path from "node:path";
import {
  appendExperimentLedger,
  appendLeadsToCsv,
  readExistingLeadDomains
} from "../lead/leadPersistence.js";
import { LeadProfileSchema } from "../lead/leadProfiles.js";
import { dedupeAndRankCandidates, normalizeDomain } from "../lead/leadScoring.js";

const LeadGenerationInputSchema = z.object({
  query: z.string().describe("Natural language search query for finding companies (e.g., 'Small MSPs in Austin, TX')"),
  vertical: z.string().describe("Vertical identifier for the CSV file (e.g., 'msp_si', 'wedding_planners')"),
  maxLeads: z.number().int().min(1).max(50).default(10).describe("Number of unique leads to attempt finding"),
  filters: z.string().optional().describe("Additional NL filters (e.g. 'less than 50 employees', 'must have a team page')"),
  profile: LeadProfileSchema.default("generic")
    .describe("ICP profile used to rank search candidates before extraction"),
  country: z.string().default("us")
    .describe("Target country code or label used for ranking and future geo filtering")
});

export const toolDefinition: ToolDefinition<typeof LeadGenerationInputSchema> = {
  name: "lead_generation",
  description: "A composite skill that discovers, filters, and extracts leads into a persistent CSV.",
  inputSchema: LeadGenerationInputSchema,
  inputHint: '{"query": "MSPs in Texas", "vertical": "msp_tx", "maxLeads": 5}',
  async execute(input, context) {
    const { query, vertical, maxLeads, filters, profile, country } = input;
    const csvPath = path.join(context.workspaceDir, `leads_${vertical}.csv`);
    const experimentLedgerPath = path.join(
      context.workspaceDir,
      `lead_experiment_${vertical}.json`
    );

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
    const existingDomains = await readExistingLeadDomains(csvPath);
    
    // 2. Search for candidates
    // We search wider than the requested lead count because extraction is the expensive step.
    await emitProgress(`Searching for ${query}...`);
    const searchResponse = await context.searchManager.search(query, maxLeads * 3);
    const rankedCandidates = dedupeAndRankCandidates(
      searchResponse.results,
      existingDomains,
      profile,
      country
    );
    const candidateUrls = rankedCandidates.map((candidate) => candidate.homepageUrl);

    await emitProgress(
      `Ranked ${candidateUrls.length} new candidates for profile ${profile}. Starting deep extraction...`
    );
    const newLeads: any[] = [];
    let processedCount = 0;
    const seenRunDomains = new Set<string>();
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
        if (seenRunDomains.has(domain)) {
          continue;
        }
        seenRunDomains.add(domain);
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
              const rankingMeta = rankedCandidates.find((candidate) => candidate.homepageUrl === url);
              result.discoveryProfile = profile;
              result.discoveryCountry = country;
              result.normalizedDomain = normalizeDomain(url);
              result.discoveryScore = rankingMeta?.score ?? 0;
              result.discoveryReasons = rankingMeta?.reasons ?? [];
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
      await appendExperimentLedger(experimentLedgerPath, newLeads.map((lead) => ({
        companyName: lead.companyName,
        normalizedDomain: lead.normalizedDomain,
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
      })));
    }

    return {
      status: "success",
      leadsFound: newLeads.length,
      leadsProcessed: processedCount,
      totalLeadsInCsv: existingDomains.size + newLeads.length,
      csvPath: csvPath,
      experimentLedgerPath,
      rankedCandidates: rankedCandidates.slice(0, 10),
      newLeads: newLeads.map(l => ({ name: l.companyName, email: l.emails[0], url: l.sourceUrl })),
      usage: totalUsage
    };
  }
};
