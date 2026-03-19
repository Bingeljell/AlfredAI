/**
 * PinchtabPool — drop-in replacement for BrowserPool using Pinchtab HTTP API.
 *
 * Pinchtab runs as a local HTTP server (default: http://127.0.0.1:9867) and
 * provides JS-rendered page content via its accessibility tree + text extraction.
 *
 * Setup:
 *   1. Install:  npm install -g pinchtab   OR  brew install pinchtab/tap/pinchtab
 *   2. Allow external URLs — add to ~/.config/pinchtab/config.json:
 *        { "security": { "idpi": { "allowedDomains": ["*"] } } }
 *   3. Set env vars:  ALFRED_ENABLE_PINCHTAB=true  PINCHTAB_START_CMD=pinchtab
 */

import type { PagePayload, PageCollectionFailure, PageCollectionResult } from "./browserPool.js";

export { type PagePayload, type PageCollectionFailure, type PageCollectionResult };

const DEFAULT_NAVIGATE_TIMEOUT_MS = 25_000;
const DEFAULT_TEXT_MAX_CHARS = 50_000;

interface PinchtabNavigateResponse {
  tabId: string;
  url: string;
  title: string;
  idpiWarning?: string;
  error?: string;
}

interface PinchtabTextResponse {
  url: string;
  title: string;
  text: string;
  truncated?: boolean;
  idpiWarning?: string;
}

interface PinchtabSnapshotNode {
  ref: string;
  role: string;
  name: string;
  depth?: number;
  value?: string;
}

interface PinchtabSnapshotResponse {
  nodes: PinchtabSnapshotNode[];
}

// Extract bare URLs from rendered page text (best-effort; used when snapshot has no hrefs)
function extractUrlsFromText(text: string, baseUrl: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>)\]]{8,}/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== new URL(baseUrl).hostname) {
        result.push(url);
      }
    } catch {
      // skip malformed
    }
  }
  return result;
}

function compactText(input: string, max: number): string {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function computeTimeoutMs(defaultMs: number, deadlineAtMs: number | undefined, reserveMs: number): number {
  if (!deadlineAtMs) return defaultMs;
  const remaining = deadlineAtMs - Date.now() - reserveMs;
  return remaining < 2000 ? 2000 : Math.min(defaultMs, remaining);
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
      // Hit the tabs list endpoint — if Pinchtab is up it will respond
      const res = await fetch(`${this.baseUrl}/tabs`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async navigateTo(url: string, timeoutMs: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(timeoutMs + 5000)
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`navigate ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as PinchtabNavigateResponse;
    if (data.idpiWarning || (!data.tabId && data.error?.includes("IDPI"))) {
      throw new Error(
        `Pinchtab IDPI restriction blocked ${url}. ` +
        `Add {"security":{"idpi":{"allowedDomains":["*"]}}} to ~/.config/pinchtab/config.json`
      );
    }
    return data.tabId;
  }

  private async fetchText(tabId: string): Promise<PinchtabTextResponse> {
    const res = await fetch(
      `${this.baseUrl}/tabs/${encodeURIComponent(tabId)}/text?maxChars=${DEFAULT_TEXT_MAX_CHARS}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) throw new Error(`text ${res.status}`);
    return res.json() as Promise<PinchtabTextResponse>;
  }

  private async fetchSnapshot(tabId: string): Promise<PinchtabSnapshotResponse | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/tabs/${encodeURIComponent(tabId)}/snapshot`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (!res.ok) return null;
      return res.json() as Promise<PinchtabSnapshotResponse>;
    } catch {
      return null;
    }
  }

  private async fetchPage(url: string, deadlineAtMs?: number): Promise<PagePayload> {
    const timeoutMs = computeTimeoutMs(DEFAULT_NAVIGATE_TIMEOUT_MS, deadlineAtMs, 2000);
    const tabId = await this.navigateTo(url, timeoutMs);

    // Fetch text and snapshot in parallel; snapshot is best-effort
    const [textResult, snapshotResult] = await Promise.all([
      this.fetchText(tabId),
      this.fetchSnapshot(tabId)
    ]);

    if (textResult.idpiWarning) {
      throw new Error(
        `Pinchtab IDPI warning for ${url}: ${textResult.idpiWarning}. ` +
        `Set allowedDomains:["*"] in Pinchtab config.`
      );
    }

    // Extract list items from snapshot (role="listitem")
    const listItems: string[] = [];
    if (snapshotResult?.nodes) {
      for (const node of snapshotResult.nodes) {
        if (node.role === "listitem" && node.name) {
          listItems.push(node.name.replace(/\s+/g, " ").trim());
        }
      }
    }

    // Extract outbound links from page text (snapshot nodes have no href field)
    const rawUrls = extractUrlsFromText(textResult.text ?? "", url);
    const outboundLinks = rawUrls.slice(0, 80).map((u) => `${u} -> ${u}`);

    return {
      url: textResult.url || url,
      title: compactText(textResult.title || "", 180),
      text: compactText(textResult.text || "", 6000),
      tableRows: [],
      listItems: listItems.map((item) => compactText(item, 220)).slice(0, 60),
      outboundLinks
    };
    // Note: no close call — Pinchtab has no tab close endpoint; tabs auto-clean when server stops
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
          pages.push(await this.fetchPage(url, deadlineAtMs));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ url, error: message.slice(0, 220) });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, () => worker()));
    return { pages, failures };
  }
}
