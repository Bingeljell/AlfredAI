export interface PagePayload {
  url: string;
  title: string;
  text: string;
  tableRows: string[];
  listItems: string[];
  outboundLinks: string[];
}

export interface PageCollectionFailure {
  url: string;
  error: string;
}

export interface PageCollectionResult {
  pages: PagePayload[];
  failures: PageCollectionFailure[];
}

function compactText(input: string, max = 5000): string {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function computeNavigationTimeout(defaultMs: number, deadlineAtMs: number | undefined, reserveMs: number): number {
  if (!deadlineAtMs) {
    return defaultMs;
  }
  const remainingMs = deadlineAtMs - Date.now() - reserveMs;
  if (remainingMs <= 1200) {
    return 1200;
  }
  return Math.max(1200, Math.min(defaultMs, remainingMs));
}

export class BrowserPool {
  private constructor(
    private readonly browser: any,
    private readonly context: any
  ) {}

  static async create(): Promise<BrowserPool> {
    let chromium: unknown;
    try {
      const importDynamic = new Function("moduleName", "return import(moduleName)") as (
        moduleName: string
      ) => Promise<{ chromium: unknown }>;
      const playwrightModule = await importDynamic("playwright");
      chromium = playwrightModule.chromium;
    } catch {
      throw new Error(
        "Playwright is required for lead pipeline. Run `npm run setup:browsers` after installing dependencies."
      );
    }

    if (!chromium || typeof chromium !== "object" || !("launch" in chromium)) {
      throw new Error("Playwright chromium launcher is unavailable");
    }

    const browser = await (chromium as { launch: (opts: { headless: boolean }) => Promise<any> }).launch({
      headless: true
    });
    const context = await browser.newContext({
      userAgent: "AlfredLeadAgent/0.2"
    });

    return new BrowserPool(browser, context);
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  private async gotoWithFallback(page: any, url: string, deadlineAtMs?: number): Promise<void> {
    if (deadlineAtMs && Date.now() >= deadlineAtMs) {
      throw new Error("deadline_exceeded_before_navigation");
    }
    const domContentLoadedTimeoutMs = computeNavigationTimeout(14000, deadlineAtMs, 800);
    const networkIdleTimeoutMs = computeNavigationTimeout(22000, deadlineAtMs, 1200);

    try {
      await page.goto(url, { timeout: domContentLoadedTimeoutMs, waitUntil: "domcontentloaded" });
      return;
    } catch (primaryError) {
      try {
        await page.goto(url, { timeout: networkIdleTimeoutMs, waitUntil: "networkidle" });
        return;
      } catch (secondaryError) {
        const first = primaryError instanceof Error ? primaryError.message : String(primaryError);
        const second = secondaryError instanceof Error ? secondaryError.message : String(secondaryError);
        throw new Error(`goto_failed domcontentloaded="${first.slice(0, 140)}" networkidle="${second.slice(0, 140)}"`);
      }
    }
  }

  private async extractPagePayload(page: any, url: string, deadlineAtMs?: number): Promise<PagePayload> {
    await this.gotoWithFallback(page, url, deadlineAtMs);

    const payload = (await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      const title = document.title || "";

      const tableRows = Array.from(document.querySelectorAll("table tr"))
        .map((row) => row.textContent || "")
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 100);

      const listItems = Array.from(document.querySelectorAll("li"))
        .map((item) => item.textContent || "")
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 120);

      const outboundLinks = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => ({
          text: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
          href: anchor.getAttribute("href") || ""
        }))
        .filter((item) => item.href)
        .slice(0, 200);

      return {
        title,
        bodyText,
        tableRows,
        listItems,
        outboundLinks
      };
    })) as {
      title: string;
      bodyText: string;
      tableRows: string[];
      listItems: string[];
      outboundLinks: Array<{ text: string; href: string }>;
    };

    const normalizedLinks = payload.outboundLinks
      .map((item) => {
        try {
          const normalized = new URL(item.href, url).toString();
          return `${item.text} -> ${normalized}`;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .slice(0, 120);

    return {
      url,
      title: compactText(payload.title, 180),
      text: compactText(payload.bodyText, 6000),
      tableRows: payload.tableRows.map((item) => compactText(item, 220)).slice(0, 80),
      listItems: payload.listItems.map((item) => compactText(item, 220)).slice(0, 80),
      outboundLinks: normalizedLinks
    };
  }

  async collectPages(urls: string[], concurrency: number, deadlineAtMs?: number): Promise<PageCollectionResult> {
    const queue = [...urls];
    const results: PagePayload[] = [];
    const failures: PageCollectionFailure[] = [];

    const worker = async (): Promise<void> => {
      const page = await this.context.newPage();
      try {
        while (queue.length > 0) {
          if (deadlineAtMs && Date.now() >= deadlineAtMs) {
            return;
          }
          const nextUrl = queue.shift();
          if (!nextUrl) {
            return;
          }
          try {
            const payload = await this.extractPagePayload(page, nextUrl, deadlineAtMs);
            results.push(payload);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({
              url: nextUrl,
              error: message.slice(0, 220)
            });
            continue;
          }
        }
      } finally {
        await page.close();
      }
    };

    const workerCount = Math.max(1, Math.min(concurrency, urls.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      pages: results,
      failures
    };
  }
}
