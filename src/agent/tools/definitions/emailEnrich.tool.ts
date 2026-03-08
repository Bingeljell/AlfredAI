import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";
import { BrowserPool, type PagePayload } from "../../../tools/lead/browserPool.js";

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "aol.com",
  "icloud.com",
  "proton.me",
  "protonmail.com"
]);

export const EmailEnrichToolInputSchema = z.object({
  maxLeads: z.number().int().min(1).max(50).optional(),
  urlCap: z.number().int().min(1).max(120).optional(),
  browseConcurrency: z.number().int().min(1).max(6).optional(),
  includeBrowserFallback: z.boolean().optional()
});

function normalizeDomain(url: string | undefined): string {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function domainFromEmail(email: string | undefined): string {
  if (!email) {
    return "";
  }
  const index = email.lastIndexOf("@");
  if (index < 0) {
    return "";
  }
  return email.slice(index + 1).toLowerCase();
}

function domainsRelated(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function normalizeEmail(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .replace(/^mailto:/i, "")
    .replace(/[),.;:!?]+$/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeEmailCandidates(value: string): string[] {
  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const normalized = matches
    .map((item) => normalizeEmail(item))
    .filter((item): item is string => Boolean(item));
  return Array.from(new Set(normalized));
}

function isAcceptableBusinessEmail(email: string, sourceDomain?: string): boolean {
  const emailDomain = domainFromEmail(email);
  if (!emailDomain) {
    return false;
  }
  if (PERSONAL_EMAIL_DOMAINS.has(emailDomain)) {
    return false;
  }
  if (sourceDomain && !domainsRelated(emailDomain, sourceDomain)) {
    return false;
  }
  return true;
}

function pickBestEmail(candidates: string[], sourceDomain?: string): string | undefined {
  const scored = candidates
    .map((email) => {
      const emailDomain = domainFromEmail(email);
      let score = 0;
      if (!emailDomain) {
        score -= 10;
      }
      if (/^info@|^contact@|^hello@|^sales@/i.test(email)) {
        score += 3;
      }
      if (/^noreply@|^no-reply@|^donotreply@/i.test(email)) {
        score -= 5;
      }
      if (PERSONAL_EMAIL_DOMAINS.has(emailDomain)) {
        score -= 6;
      }
      if (sourceDomain && domainsRelated(emailDomain, sourceDomain)) {
        score += 4;
      }
      return { email, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.email;
}

function extractEmailsFromPayload(payload: PagePayload): string[] {
  const blob = [
    payload.text,
    payload.listItems.join("\n"),
    payload.tableRows.join("\n"),
    payload.outboundLinks.join("\n")
  ].join("\n");
  return normalizeEmailCandidates(blob);
}

function buildCandidateUrls(website: string): string[] {
  try {
    const origin = new URL(website).origin;
    return [origin, `${origin}/contact`, `${origin}/contact-us`, `${origin}/about`];
  } catch {
    return [];
  }
}

function computeQuickScanTimeoutMs(deadlineAtMs?: number): number {
  if (!deadlineAtMs) {
    return 6000;
  }
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 2000) {
    return 1200;
  }
  return Math.min(6000, Math.max(1200, remaining - 500));
}

async function fetchQuickScanEmails(url: string, deadlineAtMs?: number): Promise<string[]> {
  const controller = new AbortController();
  const timeoutMs = computeQuickScanTimeoutMs(deadlineAtMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "AlfredLeadAgent/1.0"
      }
    });
    if (!response.ok) {
      return [];
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("html")) {
      return [];
    }
    const html = await response.text();
    return normalizeEmailCandidates(html.slice(0, 300_000));
  } finally {
    clearTimeout(timer);
  }
}

export const toolDefinition: LeadAgentToolDefinition<typeof EmailEnrichToolInputSchema> = {
  name: "email_enrich",
  description: "Enrich current lead state with business emails from website/contact pages.",
  inputSchema: EmailEnrichToolInputSchema,
  inputHint: "Use after lead discovery to improve email coverage; can run with or without browser fallback.",
  async execute(input, context) {
    const maxLeads = input.maxLeads ?? 20;
    const browseConcurrency = input.browseConcurrency ?? Math.max(1, Math.min(4, context.defaults.subReactBrowseConcurrency));
    const includeBrowserFallback = input.includeBrowserFallback ?? true;
    const emailCoverageBefore = context.state.leads.length
      ? context.state.leads.filter((lead) => Boolean(lead.email)).length / context.state.leads.length
      : 0;

    const candidates = context.state.leads
      .map((lead, index) => ({ lead, index }))
      .filter((item) => !item.lead.email && Boolean(item.lead.website))
      .sort((a, b) => b.lead.confidence - a.lead.confidence)
      .slice(0, maxLeads);

    const domainToLeadIndexes = new Map<string, number[]>();
    for (const item of candidates) {
      const domain = normalizeDomain(item.lead.website);
      if (!domain) {
        continue;
      }
      const indexes = domainToLeadIndexes.get(domain) ?? [];
      indexes.push(item.index);
      domainToLeadIndexes.set(domain, indexes);
    }

    const urlCap = input.urlCap ?? 60;
    const urls = Array.from(
      new Set(
        candidates.flatMap((item) => (item.lead.website ? buildCandidateUrls(item.lead.website) : []))
      )
    ).slice(0, urlCap);

    if (urls.length === 0) {
      return {
        candidateLeadCount: candidates.length,
        candidateUrlCount: 0,
        attempted: false,
        updatedLeadCount: 0,
        failureCount: 0,
        failureSamples: [],
        emailCoverageBefore,
        emailCoverageAfter: emailCoverageBefore
      };
    }

    const failureSamples: Array<{ url: string; error: string }> = [];
    let failureCount = 0;
    let quickScanAttempts = 0;
    let quickScanHits = 0;
    let updatedLeadCount = 0;
    const resolvedDomains = new Set<string>();

    for (const url of urls) {
      if (context.deadlineAtMs && Date.now() >= context.deadlineAtMs) {
        break;
      }
      const sourceDomain = normalizeDomain(url);
      if (!sourceDomain || resolvedDomains.has(sourceDomain)) {
        continue;
      }
      quickScanAttempts += 1;
      let emails: string[] = [];
      try {
        emails = await fetchQuickScanEmails(url, context.deadlineAtMs);
      } catch (error) {
        failureCount += 1;
        if (failureSamples.length < 8) {
          failureSamples.push({
            url,
            error: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)
          });
        }
      }

      const bestEmail = pickBestEmail(emails, sourceDomain);
      if (!bestEmail || !isAcceptableBusinessEmail(bestEmail, sourceDomain)) {
        continue;
      }

      const leadIndexes = domainToLeadIndexes.get(sourceDomain) ?? [];
      let updatedForDomain = 0;
      for (const leadIndex of leadIndexes) {
        const lead = context.state.leads[leadIndex];
        if (!lead || lead.email) {
          continue;
        }
        lead.email = bestEmail;
        lead.emailEvidence = "email enrichment: quick-scan";
        updatedLeadCount += 1;
        updatedForDomain += 1;
      }
      if (updatedForDomain > 0) {
        quickScanHits += 1;
        resolvedDomains.add(sourceDomain);
      }
    }

    let browserPagesVisited = 0;
    if (includeBrowserFallback) {
      const unresolvedUrls = urls.filter((url) => {
        const domain = normalizeDomain(url);
        return domain ? !resolvedDomains.has(domain) : true;
      });

      if (unresolvedUrls.length > 0) {
        const browserPool = await BrowserPool.create();
        try {
          const collection = await browserPool.collectPages(unresolvedUrls, browseConcurrency, context.deadlineAtMs);
          browserPagesVisited = collection.pages.length;
          failureCount += collection.failures.length;
          failureSamples.push(...collection.failures.slice(0, Math.max(0, 8 - failureSamples.length)));

          for (const payload of collection.pages) {
            const sourceDomain = normalizeDomain(payload.url);
            if (!sourceDomain || resolvedDomains.has(sourceDomain)) {
              continue;
            }
            const bestEmail = pickBestEmail(extractEmailsFromPayload(payload), sourceDomain);
            if (!bestEmail || !isAcceptableBusinessEmail(bestEmail, sourceDomain)) {
              continue;
            }
            const leadIndexes = domainToLeadIndexes.get(sourceDomain) ?? [];
            let updatedForDomain = 0;
            for (const leadIndex of leadIndexes) {
              const lead = context.state.leads[leadIndex];
              if (!lead || lead.email) {
                continue;
              }
              lead.email = bestEmail;
              lead.emailEvidence = "email enrichment: browser-fetch";
              updatedLeadCount += 1;
              updatedForDomain += 1;
            }
            if (updatedForDomain > 0) {
              resolvedDomains.add(sourceDomain);
            }
          }
        } finally {
          await browserPool.close();
        }
      }
    }

    const emailCoverageAfter = context.state.leads.length
      ? context.state.leads.filter((lead) => Boolean(lead.email)).length / context.state.leads.length
      : 0;

    return {
      candidateLeadCount: candidates.length,
      candidateUrlCount: urls.length,
      attempted: true,
      updatedLeadCount,
      failureCount,
      failureSamples: failureSamples.slice(0, 8),
      quickScanAttempts,
      quickScanHits,
      browserPagesVisited,
      emailCoverageBefore,
      emailCoverageAfter
    };
  }
};
