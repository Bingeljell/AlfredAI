import { BrowserPool, type PageCollectionResult, type PageCollector } from "./browserPool.js";
import { PinchtabPool } from "./pinchtabPool.js";

export type ReadOnlyBrowserBackend = "pinchtab" | "playwright";

interface PreferredBrowserPoolOptions {
  pinchtabBaseUrl?: string;
  enablePlaywright: boolean;
  createPinchtab?: (baseUrl: string) => PageCollector & { health(): Promise<boolean> };
  createPlaywright?: () => Promise<PageCollector>;
}

/**
 * One read-only browser session with deterministic backend preference.
 *
 * Pinchtab is selected whenever it is configured and healthy. Playwright is
 * created lazily only when Pinchtab is unavailable or fails before returning
 * any pages. Once fallback occurs, the session stays on Playwright so a single
 * web_fetch run does not mix browser state across retry batches.
 */
export class PreferredBrowserPool implements PageCollector {
  private active?: PageCollector;
  private activeBackend?: ReadOnlyBrowserBackend;
  private fallbackReason?: string;

  constructor(private readonly options: PreferredBrowserPoolOptions) {}

  get backend(): ReadOnlyBrowserBackend | undefined {
    return this.activeBackend;
  }

  get browserFallbackReason(): string | undefined {
    return this.fallbackReason;
  }

  private async usePlaywright(reason: string): Promise<PageCollector> {
    if (!this.options.enablePlaywright) {
      throw new Error(
        `Pinchtab unavailable (${reason}) and Playwright fallback is disabled. ` +
        "Restore Pinchtab or set ALFRED_ENABLE_PLAYWRIGHT=true."
      );
    }
    await this.active?.close();
    this.active = await (this.options.createPlaywright ?? (() => BrowserPool.create()))();
    this.activeBackend = "playwright";
    this.fallbackReason = reason;
    return this.active;
  }

  private async selectInitialBackend(): Promise<PageCollector> {
    if (this.active) return this.active;

    if (this.options.pinchtabBaseUrl) {
      const pinchtab = (this.options.createPinchtab ?? ((baseUrl) => PinchtabPool.create(baseUrl)))(
        this.options.pinchtabBaseUrl
      );
      if (await pinchtab.health()) {
        this.active = pinchtab;
        this.activeBackend = "pinchtab";
        return pinchtab;
      }
      return this.usePlaywright("pinchtab_unhealthy");
    }

    return this.usePlaywright("pinchtab_not_configured");
  }

  async collectPages(
    urls: string[],
    concurrency: number,
    deadlineAtMs?: number
  ): Promise<PageCollectionResult> {
    const pool = await this.selectInitialBackend();
    const result = await pool.collectPages(urls, concurrency, deadlineAtMs);

    if (
      this.activeBackend === "pinchtab" &&
      result.pages.length === 0 &&
      result.failures.length > 0
    ) {
      const firstFailure = result.failures[0]?.error ?? "pinchtab_collection_failed";
      const playwright = await this.usePlaywright(`pinchtab_failed: ${firstFailure.slice(0, 160)}`);
      return playwright.collectPages(urls, concurrency, deadlineAtMs);
    }

    return result;
  }

  async close(): Promise<void> {
    await this.active?.close();
    this.active = undefined;
    this.activeBackend = undefined;
  }
}
