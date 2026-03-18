/**
 * PinchtabPool — drop-in replacement for BrowserPool using Pinchtab HTTP API.
 *
 * Pinchtab runs as a local HTTP server (default: http://127.0.0.1:9867) and
 * provides JS-rendered page content via its accessibility tree + text extraction.
 *
 * Setup requirements:
 *   1. Install Pinchtab: https://pinchtab.com/docs/get-started/
 *   2. Disable IDPI in Pinchtab config (required for external sites):
 *      pinchtab config init  →  set security.idpi = false
 *   3. Start Pinchtab: pinchtab
 *   4. Set PINCHTAB_BASE_URL env var if not using default port
 */

import type { PagePayload, PageCollectionFailure, PageCollectionResult } from "./browserPool.js";

export { type PagePayload, type PageCollectionFailure, type PageCollectionResult };

const DEFAULT_NAVIGATE_TIMEOUT_MS = 20_000;
const DEFAULT_TEXT_MAX_CHARS = 50_000;

interface PinchtabNavigateResponse {
  tabId: string;
  url: string;
  title: string;
}

interface PinchtabTextResponse {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

interface PinchtabSnapshotNode {
  ref: string;
  role: string;
  name: string;
  href?: string;
  value?: string | null;
}

interface PinchtabSnapshotResponse {
  url: string;
  title: string;
  nodes: PinchtabSnapshotNode[];
  count: number;
}

function compactText(input: string, max = 5000): string {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function computeDeadlineTimeout(defaultMs: number, deadlineAtMs: number | undefined, reserveMs: number): number {
  if (!deadlineAtMs) return defaultMs;
  const remaining = deadlineAtMs - Date.now() - reserveMs;
  if (remaining <= 2000) return 2000;
  return Math.min(defaultMs, remaining);
}

export class PinchtabPool {
  constructor(private readonly baseUrl: string) {}

  static create(baseUrl = "http://127.0.0.1:9867"): PinchtabPool {
    return new PinchtabPool(baseUrl);
  }

  /** No-op for interface compatibility with BrowserPool. */
  async close(): Promise<void> {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async navigateTo(url: string, timeoutMs: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        newTab: true,
        blockImages: true,
        waitFor: "networkidle",
        timeout: timeoutMs
      }),
      signal: AbortSignal.timeout(timeoutMs + 5000)
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`navigate failed ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as PinchtabNavigateResponse;
    return data.tabId;
  }

  private async fetchText(tabId: string): Promise<PinchtabTextResponse> {
    const res = await fetch(
      `${this.baseUrl}/tabs/${encodeURIComponent(tabId)}/text?mode=raw&maxChars=${DEFAULT_TEXT_MAX_CHARS}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) throw new Error(`text fetch failed ${res.status}`);
    return res.json() as Promise<PinchtabTextResponse>;
  }

  private async fetchSnapshot(tabId: string): Promise<PinchtabSnapshotResponse> {
    const res = await fetch(
      `${this.baseUrl}/tabs/${encodeURIComponent(tabId)}/snapshot?filter=all&format=compact`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) throw new Error(`snapshot fetch failed ${res.status}`);
    return res.json() as Promise<PinchtabSnapshotResponse>;
  }

  private async closeTab(tabId: string): Promise<void> {
    await fetch(`${this.baseUrl}/tabs/${encodeURIComponent(tabId)}/close`, {
      method: "POST",
      signal: AbortSignal.timeout(5000)
    }).catch(() => {
      // best-effort close
    });
  }

  private async fetchPage(url: string, deadlineAtMs?: number): Promise<PagePayload> {
    const timeoutMs = computeDeadlineTimeout(DEFAULT_NAVIGATE_TIMEOUT_MS, deadlineAtMs, 2000);

    const tabId = await this.navigateTo(url, timeoutMs);

    try {
      const [textResult, snapshotResult] = await Promise.all([
        this.fetchText(tabId),
        this.fetchSnapshot(tabId).catch(() => null)
      ]);

      // Extract outbound links from accessibility tree
      const outboundLinks: string[] = [];
      const listItems: string[] = [];

      if (snapshotResult) {
        for (const node of snapshotResult.nodes) {
          if (node.href) {
            try {
              const resolved = new URL(node.href, url).toString();
              const label = node.name?.replace(/\s+/g, " ").trim() || node.href;
              outboundLinks.push(`${label} -> ${resolved}`);
            } catch {
              // skip unparseable hrefs
            }
          }
          if (node.role === "listitem" && node.name) {
            listItems.push(node.name.replace(/\s+/g, " ").trim());
          }
        }
      }

      return {
        url: textResult.url || url,
        title: compactText(textResult.title || "", 180),
        text: compactText(textResult.text || "", 6000),
        tableRows: [], // Pinchtab accessibility tree doesn't expose table rows directly; text covers this
        listItems: listItems.map((item) => compactText(item, 220)).slice(0, 80),
        outboundLinks: outboundLinks.slice(0, 120)
      };
    } finally {
      await this.closeTab(tabId);
    }
  }

  async collectPages(urls: string[], concurrency: number, deadlineAtMs?: number): Promise<PageCollectionResult> {
    const queue = [...urls];
    const pages: PagePayload[] = [];
    const failures: PageCollectionFailure[] = [];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (deadlineAtMs && Date.now() >= deadlineAtMs) return;
        const url = queue.shift();
        if (!url) return;
        try {
          const page = await this.fetchPage(url, deadlineAtMs);
          pages.push(page);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ url, error: message.slice(0, 220) });
        }
      }
    };

    const workerCount = Math.max(1, Math.min(concurrency, urls.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { pages, failures };
  }
}
