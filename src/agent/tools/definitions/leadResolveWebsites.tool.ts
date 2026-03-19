import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";

/**
 * Domains that are directories, aggregators, or social platforms — never a company's own website.
 * Mirrors the list in subReactPipeline.ts with common additions.
 */
const AGGREGATOR_DOMAIN_PATTERNS = [
  "clutch.co",
  "discovermsps.com",
  "designrush.com",
  "goodfirms.co",
  "mspaa.net",
  "upcity.com",
  "topseos.com",
  "g2.com",
  "capterra.com",
  "msp-seo.agency",
  "mspseo.agency",
  "infomsp.com",
  "mspdirectory.com",
  "mspdatabase.com",
  "themanifest.com",
  "cloudtango.net",
  "outsourcedmsp.com",
  "cloudsecuretech.com",
  "pivotglobalservices.com",
  "crn.com",
  "yelp.com",
  "yellowpages.com",
  "bbb.org",
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "wikipedia.org",
  "indeed.com",
  "glassdoor.com",
  "zoominfo.com",
  "dnb.com",
  "bloomberg.com",
  "crunchbase.com"
];

function normalizeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isAggregatorOrDirectory(domain: string): boolean {
  return AGGREGATOR_DOMAIN_PATTERNS.some(
    (blocked) => domain === blocked || domain.endsWith(`.${blocked}`)
  );
}

const LeadResolveWebsitesInputSchema = z.object({
  maxToResolve: z.number().int().min(1).max(30).default(20).optional(),
  searchContext: z.string().max(200).optional()
});

export const toolDefinition: LeadAgentToolDefinition<typeof LeadResolveWebsitesInputSchema> = {
  name: "lead_resolve_websites",
  description:
    "For leads that are missing a website URL, search the web to find their official site. " +
    "Call this after lead_pipeline when emailEnrichmentAttempted=false or websiteMissingCount is high. " +
    "Must run before email_enrich — email enrichment cannot work without websites.",
  inputSchema: LeadResolveWebsitesInputSchema,
  inputHint: '{"maxToResolve": 20, "searchContext": "managed service provider Texas"}',

  async execute(input, context) {
    const maxToResolve = input.maxToResolve ?? 20;
    const contextSuffix = input.searchContext?.trim() ?? "";

    const websiteCountBefore = context.state.leads.filter((l) => Boolean(l.website)).length;

    // Leads missing a website, sorted highest confidence first
    const targets = context.state.leads
      .map((lead, index) => ({ lead, index }))
      .filter(({ lead }) => !lead.website && Boolean(lead.companyName?.trim()))
      .sort((a, b) => b.lead.confidence - a.lead.confidence)
      .slice(0, maxToResolve);

    if (targets.length === 0) {
      const noTargetsReason =
        context.state.leads.length === 0
          ? "no_leads_in_state_run_lead_pipeline_first"
          : "all_leads_already_have_websites";
      return {
        attemptedCount: 0,
        resolvedCount: 0,
        failedCount: 0,
        websiteCountBefore,
        websiteCountAfter: websiteCountBefore,
        noTargetsReason
      };
    }

    let resolvedCount = 0;
    let failedCount = 0;
    const samples: Array<{ companyName: string; resolvedWebsite?: string; status: string }> = [];

    for (const { lead, index } of targets) {
      // Stop if deadline is within 10 seconds
      if (context.deadlineAtMs && Date.now() >= context.deadlineAtMs - 10_000) {
        break;
      }

      const locationClause = lead.location ? ` ${lead.location}` : "";
      const primaryQuery = contextSuffix
        ? `"${lead.companyName}" ${contextSuffix}`
        : `"${lead.companyName}"${locationClause} official site`;
      const fallbackQuery = contextSuffix
        ? `${lead.companyName} ${contextSuffix} website`
        : `${lead.companyName}${locationClause} IT services website`;

      const findGood = (results: Array<{ url: string }>) =>
        results.find((r) => {
          const domain = normalizeDomain(r.url);
          return domain && !isAggregatorOrDirectory(domain);
        });

      try {
        const primary = await context.searchManager.search(primaryQuery, 10);
        let firstGood = findGood(primary.results);

        if (!firstGood) {
          // Retry without quotes — broader match
          const fallback = await context.searchManager.search(fallbackQuery, 10);
          firstGood = findGood(fallback.results);
        }

        if (firstGood) {
          try {
            const origin = new URL(firstGood.url).origin;
            context.state.leads[index]!.website = origin;
            resolvedCount++;
            if (samples.length < 8) {
              samples.push({ companyName: lead.companyName, resolvedWebsite: origin, status: "resolved" });
            }
          } catch {
            failedCount++;
            if (samples.length < 8) {
              samples.push({ companyName: lead.companyName, status: "url_parse_failed" });
            }
          }
        } else {
          failedCount++;
          if (samples.length < 8) {
            samples.push({ companyName: lead.companyName, status: "no_non_directory_result" });
          }
        }
      } catch {
        failedCount++;
        if (samples.length < 8) {
          samples.push({ companyName: lead.companyName, status: "search_failed" });
        }
      }
    }

    const websiteCountAfter = context.state.leads.filter((l) => Boolean(l.website)).length;

    return {
      attemptedCount: targets.length,
      resolvedCount,
      failedCount,
      websiteCountBefore,
      websiteCountAfter,
      samples
    };
  }
};
