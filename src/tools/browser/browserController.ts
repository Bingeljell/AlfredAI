/**
 * browserController — persistent, session-scoped browser control for Alfred.
 *
 * Unlike `web_fetch` (one-shot read-only extraction), the controller keeps one
 * headless Chromium instance alive per chat session so the agent can navigate,
 * inspect, click, type, screenshot, and move through history across tool calls.
 *
 * Lifecycle:
 *   - Lazy launch: the browser starts on first use and stays open.
 *   - Idle sweep: sessions untouched for `idleCloseMs` are closed opportunistically.
 *   - Explicit close: `browser_close` releases the session browser.
 *   - Process exit: a best-effort hook disposes all live sessions.
 */

import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  evaluateDomScript,
  evaluateDomScriptWithArgs
} from "./browserDom.js";
import type { DomActionResult, DomSnapshot } from "./browserDom.js";

export interface BrowserLaunchResult {
  browser: any;
  context: any;
  page: any;
}

export type BrowserLaunch = () => Promise<BrowserLaunchResult>;

export interface BrowserTabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface ScreenshotResult {
  filePath: string;
  bytes: number;
}

const DEFAULT_NAVIGATE_TIMEOUT_MS = 25_000;
const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;

async function defaultLaunch(): Promise<BrowserLaunchResult> {
  let chromium: unknown;
  try {
    const importDynamic = new Function("moduleName", "return import(moduleName)") as (
      moduleName: string
    ) => Promise<{ chromium: unknown }>;
    const playwrightModule = await importDynamic("playwright");
    chromium = playwrightModule.chromium;
  } catch {
    throw new Error(
      "Playwright is required for browser control. Run `pnpm exec playwright install chromium` after installing dependencies."
    );
  }

  if (!chromium || typeof chromium !== "object" || !("launch" in chromium)) {
    throw new Error("Playwright chromium launcher is unavailable");
  }

  const browser = await (chromium as { launch: (opts: { headless: boolean }) => Promise<any> }).launch({
    headless: true
  });
  const context = await browser.newContext({
    userAgent: "AlfredBrowserControl/1.0",
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();
  return { browser, context, page };
}

function computeTimeoutMs(defaultMs: number, deadlineAtMs: number | undefined, reserveMs: number): number {
  if (!deadlineAtMs) {
    return defaultMs;
  }
  const remainingMs = deadlineAtMs - Date.now() - reserveMs;
  if (remainingMs <= 1200) {
    return 1200;
  }
  return Math.max(1200, Math.min(defaultMs, remainingMs));
}

/** Default PNG file name for a screenshot; `name` is sanitized by the caller. */
export function defaultScreenshotName(nowMs: number, name?: string): string {
  const base = name && name.trim().length > 0 ? name.trim() : `screenshot-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}`;
  return base.endsWith(".png") ? base : `${base}.png`;
}

export class BrowserController {
  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private lastActiveAtMs: number = Date.now();
  private closed = false;

  constructor(
    readonly sessionId: string,
    private readonly launch: BrowserLaunch = defaultLaunch
  ) {}

  get isOpen(): boolean {
    return this.browser !== null && !this.closed;
  }

  get idleMs(): number {
    return Date.now() - this.lastActiveAtMs;
  }

  private touch(): void {
    this.lastActiveAtMs = Date.now();
  }

  private async ensureBrowser(): Promise<void> {
    this.touch();
    if (this.isOpen) {
      return;
    }
    const { browser, context, page } = await this.launch();
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.closed = false;
  }

  private requirePage(): any {
    if (!this.isOpen || !this.page) {
      throw new Error("browser_not_open: call browser_navigate first to open a page");
    }
    return this.page;
  }

  private async waitForLoad(page: any, deadlineAtMs?: number): Promise<void> {
    const timeoutMs = computeTimeoutMs(5000, deadlineAtMs, 800);
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    } catch {
      // best-effort — the next snapshot reflects reality
    }
  }

  async navigate(url: string, deadlineAtMs?: number): Promise<DomSnapshot> {
    await this.ensureBrowser();
    const timeoutMs = computeTimeoutMs(DEFAULT_NAVIGATE_TIMEOUT_MS, deadlineAtMs, 1200);
    await this.page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    return this.snapshot();
  }

  async snapshot(): Promise<DomSnapshot> {
    this.touch();
    const page = this.requirePage();
    return evaluateDomScript<DomSnapshot>(page, "collectPageSnapshot");
  }

  async click(args: { index?: number; text?: string }, deadlineAtMs?: number): Promise<DomActionResult & { url: string }> {
    this.touch();
    const page = this.requirePage();
    const result = await evaluateDomScriptWithArgs<DomActionResult>(page, "performClick", args);
    if (!result.ok) {
      return { ...result, url: page.url() };
    }
    await this.waitForLoad(page, deadlineAtMs);
    return { ...result, url: page.url() };
  }

  async type(args: { index?: number; text?: string; value: string }): Promise<DomActionResult> {
    this.touch();
    const page = this.requirePage();
    return evaluateDomScriptWithArgs<DomActionResult>(page, "performType", args);
  }

  async pressKey(key: string, deadlineAtMs?: number): Promise<{ key: string; url: string }> {
    this.touch();
    const page = this.requirePage();
    await page.keyboard.press(key, { timeout: computeTimeoutMs(5000, deadlineAtMs, 800) });
    await this.waitForLoad(page, deadlineAtMs);
    return { key, url: page.url() };
  }

  async goBack(deadlineAtMs?: number): Promise<DomSnapshot> {
    this.touch();
    const page = this.requirePage();
    await page.goBack({ timeout: computeTimeoutMs(DEFAULT_NAVIGATE_TIMEOUT_MS, deadlineAtMs, 1200) });
    return this.snapshot();
  }

  async goForward(deadlineAtMs?: number): Promise<DomSnapshot> {
    this.touch();
    const page = this.requirePage();
    await page.goForward({ timeout: computeTimeoutMs(DEFAULT_NAVIGATE_TIMEOUT_MS, deadlineAtMs, 1200) });
    return this.snapshot();
  }

  async reload(deadlineAtMs?: number): Promise<DomSnapshot> {
    this.touch();
    const page = this.requirePage();
    await page.reload({ timeout: computeTimeoutMs(DEFAULT_NAVIGATE_TIMEOUT_MS, deadlineAtMs, 1200), waitUntil: "domcontentloaded" });
    return this.snapshot();
  }

  async screenshot(outputDir: string, fileName: string, fullPage: boolean): Promise<ScreenshotResult> {
    this.touch();
    const page = this.requirePage();
    await mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, fileName);
    await page.screenshot({ path: filePath, fullPage });
    const fileStat = await stat(filePath);
    return { filePath, bytes: fileStat.size };
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    this.touch();
    const pages = this.context ? this.context.pages() : [];
    return pages.map((candidate: any, index: number) => ({
      index,
      url: candidate.url(),
      title: candidate.title() ?? "",
      active: candidate === this.page
    }));
  }

  async openTab(url: string, deadlineAtMs?: number): Promise<BrowserTabInfo[]> {
    await this.ensureBrowser();
    this.touch();
    const next = await this.context.newPage();
    this.page = next;
    await next.goto(url, { timeout: computeTimeoutMs(DEFAULT_NAVIGATE_TIMEOUT_MS, deadlineAtMs, 1200), waitUntil: "domcontentloaded" });
    return this.listTabs();
  }

  async activateTab(index: number): Promise<BrowserTabInfo[]> {
    this.touch();
    const pages = this.context ? this.context.pages() : [];
    const target = pages[index];
    if (!target) {
      throw new Error(`tab index ${index} not found (${pages.length} tabs open)`);
    }
    await target.bringToFront();
    this.page = target;
    return this.listTabs();
  }

  async closeTab(index: number): Promise<BrowserTabInfo[]> {
    this.touch();
    const pages = this.context ? this.context.pages() : [];
    if (pages.length <= 1) {
      throw new Error("cannot close the last tab");
    }
    const target = pages[index];
    if (!target) {
      throw new Error(`tab index ${index} not found (${pages.length} tabs open)`);
    }
    if (target === this.page) {
      this.page = pages.find((candidate: any) => candidate !== target) ?? pages[0];
    }
    await target.close();
    return this.listTabs();
  }

  async close(): Promise<void> {
    this.touch();
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (browser && typeof browser.close === "function") {
      try {
        await browser.close();
      } catch {
        // best-effort shutdown — chromium child processes die with the parent
      }
    }
  }
}

/**
 * Registry of live browser sessions keyed by chat session id. Swappable factory
 * and idle window make the sweep/close semantics unit-testable without Chromium.
 */
export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, BrowserController>();

  constructor(
    private readonly factory: (sessionId: string) => BrowserController,
    private readonly idleCloseMs: number = DEFAULT_IDLE_CLOSE_MS
  ) {}

  size(): number {
    return this.sessions.size;
  }

  async forSession(sessionId: string): Promise<BrowserController> {
    // Opportunistic sweep: drop abandoned sessions before reusing the map.
    await this.sweepIdle();
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.isOpen) {
      this.sessions.delete(sessionId);
    }
    const controller = this.sessions.get(sessionId) ?? this.factory(sessionId);
    this.sessions.set(sessionId, controller);
    return controller;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const controller = this.sessions.get(sessionId);
    if (!controller) {
      return false;
    }
    this.sessions.delete(sessionId);
    await controller.close();
    return true;
  }

  async sweepIdle(): Promise<string[]> {
    const closedIds: string[] = [];
    const expired: BrowserController[] = [];
    for (const [sessionId, controller] of this.sessions) {
      if (controller.idleMs > this.idleCloseMs) {
        this.sessions.delete(sessionId);
        expired.push(controller);
        closedIds.push(sessionId);
      }
    }
    await Promise.all(expired.map((controller) => controller.close()));
    return closedIds;
  }

  async disposeAll(): Promise<void> {
    const controllers = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(controllers.map((controller) => controller.close()));
  }
}

export const browserSessions = new BrowserSessionRegistry(
  (sessionId) => new BrowserController(sessionId),
  DEFAULT_IDLE_CLOSE_MS
);

// Best-effort process-exit cleanup. `exit` handlers are sync; the async close is
// fire-and-forget, and chromium child processes are killed with the parent anyway.
const REGISTRIES: BrowserSessionRegistry[] = [browserSessions];
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const registry of REGISTRIES) {
      void registry.disposeAll();
    }
  });
}
installExitHook();
