import type { LeadCandidate, SearchResult } from "../../types.js";

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export async function scrapeLeadCandidatesWithPlaywright(results: SearchResult[]): Promise<LeadCandidate[]> {
  let chromium: unknown;
  try {
    const importDynamic = new Function("moduleName", "return import(moduleName)") as (
      moduleName: string
    ) => Promise<{ chromium: unknown }>;
    const playwrightModule = await importDynamic("playwright");
    chromium = playwrightModule.chromium;
  } catch {
    // Playwright is optional in this MVP; missing dependency means no enrichment pass.
    return [];
  }

  if (!chromium || typeof chromium !== "object" || !("launch" in chromium)) {
    return [];
  }

  const browser = await (chromium as { launch: (opts: { headless: boolean }) => Promise<any> }).launch({
    headless: true
  });

  const candidates: LeadCandidate[] = [];
  try {
    for (const result of results) {
      const page = await browser.newPage();
      try {
        await page.goto(result.url, { timeout: 15000, waitUntil: "domcontentloaded" });
        const text = String((await page.textContent("body")) ?? "");
        const emails = Array.from(new Set(text.match(EMAIL_REGEX) ?? []));
        candidates.push({
          companyName: result.title,
          email: emails[0],
          emailConfidence: emails[0] ? 0.65 : 0.25,
          sourceUrls: [result.url],
          notes: "Playwright enrichment"
        });
      } catch {
        // Best-effort enrichment.
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return candidates;
}
