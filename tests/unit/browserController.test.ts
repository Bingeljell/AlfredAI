import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BrowserController,
  BrowserSessionRegistry,
  defaultScreenshotName
} from "../../src/tools/browser/browserController.js";

// ─── Fake browser harness ────────────────────────────────────────────────────

function fakeEl(tagName: string, attrs: Record<string, string>, extra: Record<string, unknown> = {}): any {
  const el: any = {
    tagName,
    getAttribute(name: string) {
      return attrs[name] ?? null;
    },
    click() {
      el.clicked = true;
    },
    focus() {
      el.focused = true;
    },
    scrollIntoView() {
      el.scrolledIntoView = true;
    },
    dispatchEvent(event: any) {
      (el.events ??= []).push(event.type);
      return true;
    },
    ...extra
  };
  return el;
}

function fakeDoc(opts: {
  bodyText?: string;
  title?: string;
  url?: string;
  interactives?: any[];
  links?: any[];
}): any {
  const { interactives = [], links = [] } = opts;
  return {
    title: opts.title ?? "",
    location: { href: opts.url ?? "https://example.com/" },
    body: { innerText: opts.bodyText ?? "" },
    querySelectorAll(selector: string) {
      return selector === "a[href]" ? links : interactives;
    },
    querySelector(selector: string) {
      const all = [...interactives, ...links];
      return all.find((el) => buildCssSelectorForTest(el) === selector) ?? null;
    }
  };
}

function buildCssSelectorForTest(el: any): string {
  // Minimal re-implementation of the selector logic for the fake doc.
  const tag = el.tagName.toLowerCase();
  if (typeof el.id === "string" && el.id) {
    return `${tag}#${el.id}`;
  }
  const attr = (name: string) => {
    const value = el.getAttribute(name);
    return value ? `${tag}[${name}="${value}"]` : null;
  };
  return attr("aria-label") ?? attr("data-testid") ?? attr("name") ?? attr("type") ?? tag;
}

function fakePageState(onClose?: () => void) {
  let url = "about:blank";
  const state: any = {
    pressedKeys: [] as string[],
    screenshots: [] as Array<{ path: string; fullPage: boolean }>,
    goto: async (target: string) => {
      url = target;
    },
    goBack: async () => {
      url = "https://example.com/back";
    },
    goForward: async () => {
      url = "https://example.com/forward";
    },
    reload: async () => {},
    url: () => url,
    title: () => "Fake Page",
    evaluate: async (script: Function, arg?: unknown) => (arg === undefined ? script() : script(arg)),
    waitForLoadState: async () => {},
    keyboard: {
      press: async (key: string) => {
        state.pressedKeys.push(key);
      }
    },
    bringToFront: async () => {},
    close: async () => {
      state.closed = true;
      onClose?.();
    },
    screenshot: async (opts: { path: string; fullPage: boolean }) => {
      state.screenshots.push(opts);
      await writeFile(opts.path, "fake-png");
    }
  };
  return state;
}

function makeHarness() {
  const pages: any[] = [];
  const closedPages: any[] = [];
  const context = {
    pages: () => pages,
    newPage: async () => {
      let page: any;
      page = fakePageState(() => {
        const index = pages.indexOf(page);
        if (index >= 0) {
          pages.splice(index, 1);
        }
      });
      pages.push(page);
      return page;
    }
  };
  const browser: any = {
    newContext: async () => context,
    close: async () => {
      browser.closed = true;
    }
  };
  return { pages, closedPages, context, browser };
}

function setGlobalDoc(doc: any): void {
  (globalThis as any).document = doc;
}

function clearGlobalDoc(): void {
  delete (globalThis as any).document;
}

// BrowserController.snapshot() runs the real page-script bundle, which references
// the global `document` — polyfill it with a fake doc for every test by default.
beforeEach(() => {
  setGlobalDoc(fakeDoc({ title: "Page", url: "https://example.com/" }));
});

afterEach(() => {
  clearGlobalDoc();
});

const DEADLINE = Date.now() + 120_000;

// ─── defaultScreenshotName ───────────────────────────────────────────────────

test("defaultScreenshotName appends .png and falls back to a timestamped name", () => {
  assert.equal(defaultScreenshotName(1_700_000_000_000, "checkout"), "checkout.png");
  assert.equal(defaultScreenshotName(1_700_000_000_000, "step-2.png"), "step-2.png");
  assert.match(defaultScreenshotName(1_700_000_000_000), /^screenshot-\d{4}-\d{2}-\d{2}T.+.png$/);
});

// ─── BrowserController lifecycle ─────────────────────────────────────────────

test("navigate lazily launches the browser once and returns a snapshot", async () => {
  const harness = makeHarness();
  let launchCount = 0;
  const controller = new BrowserController("s1", async () => {
    launchCount += 1;
    return { browser: harness.browser, context: harness.context, page: harness.pages[0] ?? (await harness.context.newPage()) };
  });

  assert.equal(controller.isOpen, false);
  setGlobalDoc(fakeDoc({ title: "Home", url: "https://example.com/" }));
  try {
    const snapshot = await controller.navigate("https://example.com/", DEADLINE);
    assert.equal(launchCount, 1);
    assert.equal(controller.isOpen, true);
    assert.equal(harness.pages[0].url(), "https://example.com/");
    assert.equal(snapshot.title, "Home");
    assert.equal(snapshot.url, "https://example.com/");

    await controller.navigate("https://example.com/other", DEADLINE);
    assert.equal(launchCount, 1, "browser must not relaunch for an existing session");
    assert.equal(harness.pages[0].url(), "https://example.com/other");
  } finally {
    clearGlobalDoc();
  }
});

test("snapshot before any navigation rejects with browser_not_open", async () => {
  const controller = new BrowserController("s2", async () => {
    throw new Error("launch must not run before browser_not_open");
  });
  await assert.rejects(controller.snapshot(), /browser_not_open/);
});

test("close shuts down the browser and marks the session closed", async () => {
  const harness = makeHarness();
  const controller = new BrowserController("s3", async () => {
    return { browser: harness.browser, context: harness.context, page: await harness.context.newPage() };
  });
  await controller.navigate("https://example.com/", DEADLINE);
  assert.equal(controller.isOpen, true);
  await controller.close();
  assert.equal(controller.isOpen, false);
  assert.equal(harness.browser.closed, true);
  await controller.close(); // idempotent
});

// ─── Interaction operations ──────────────────────────────────────────────────

test("click resolves by index against the live document", async () => {
  const harness = makeHarness();
  const controller = new BrowserController("s4", async () => {
    return { browser: harness.browser, context: harness.context, page: harness.pages[0] ?? (await harness.context.newPage()) };
  });
  await controller.navigate("https://example.com/", DEADLINE);
  const button = fakeEl("BUTTON", {}, { textContent: "Go" });
  setGlobalDoc(fakeDoc({ interactives: [button] }));
  try {
    const result = await controller.click({ index: 0 }, DEADLINE);
    assert.equal(result.ok, true);
    assert.equal(result.target, "Go");
    assert.equal(button.clicked, true);
    assert.equal(result.url, "https://example.com/");

    const missing = await controller.click({ index: 9 }, DEADLINE);
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /index 9 not found/);
  } finally {
    clearGlobalDoc();
  }
});

test("type fills the targeted input through the page script", async () => {
  const harness = makeHarness();
  const controller = new BrowserController("s5", async () => {
    return { browser: harness.browser, context: harness.context, page: harness.pages[0] ?? (await harness.context.newPage()) };
  });
  await controller.navigate("https://example.com/", DEADLINE);
  const input = fakeEl("INPUT", { type: "text" }, { value: "" });
  setGlobalDoc(fakeDoc({ interactives: [input] }));
  try {
    const result = await controller.type({ index: 0, value: "hello" });
    assert.equal(result.ok, true);
    assert.equal(input.value, "hello");
  } finally {
    clearGlobalDoc();
  }
});

test("pressKey, goBack, goForward, and reload drive the page", async () => {
  const harness = makeHarness();
  const controller = new BrowserController("s6", async () => {
    return { browser: harness.browser, context: harness.context, page: harness.pages[0] ?? (await harness.context.newPage()) };
  });
  await controller.navigate("https://example.com/a", DEADLINE);
  setGlobalDoc(fakeDoc({ title: "Page", url: "https://example.com/" }));

  await controller.pressKey("Enter", DEADLINE);
  assert.deepEqual(harness.pages[0].pressedKeys, ["Enter"]);

  await controller.goBack(DEADLINE);
  assert.equal(harness.pages[0].url(), "https://example.com/back");
  await controller.goForward(DEADLINE);
  assert.equal(harness.pages[0].url(), "https://example.com/forward");
  await controller.reload(DEADLINE);
  assert.equal(harness.pages[0].url(), "https://example.com/forward");
});

// ─── Tabs ────────────────────────────────────────────────────────────────────

test("tabs can be opened, activated, listed, and closed", async () => {
  const harness = makeHarness();
  const controller = new BrowserController("s7", async () => {
    return { browser: harness.browser, context: harness.context, page: harness.pages[0] ?? (await harness.context.newPage()) };
  });
  await controller.navigate("https://example.com/a", DEADLINE);
  assert.equal(harness.pages.length, 1);

  const afterOpen = await controller.openTab("https://example.com/b", DEADLINE);
  assert.equal(harness.pages.length, 2);
  assert.equal(harness.pages[1].url(), "https://example.com/b");
  assert.equal(afterOpen[1]?.active, true);

  const afterActivate = await controller.activateTab(0);
  assert.equal(afterActivate[0]?.active, true);

  const closedPage = harness.pages[1];
  const afterClose = await controller.closeTab(1);
  assert.equal(afterClose.length, 1);
  assert.equal(closedPage.closed, true);

  await assert.rejects(controller.closeTab(0), /cannot close the last tab/);
  await assert.rejects(controller.activateTab(5), /tab index 5 not found/);
});

// ─── Screenshot ──────────────────────────────────────────────────────────────

test("screenshot writes a PNG under the requested directory", async () => {
  const harness = makeHarness();
  const controller = new BrowserController("s8", async () => {
    return { browser: harness.browser, context: harness.context, page: harness.pages[0] ?? (await harness.context.newPage()) };
  });
  await controller.navigate("https://example.com/", DEADLINE);

  const dir = await mkdtemp(path.join(tmpdir(), "alfred-browser-"));
  try {
    const result = await controller.screenshot(dir, "shot.png", false);
    assert.equal(result.filePath, path.join(dir, "shot.png"));
    assert.equal(result.bytes, "fake-png".length);
    assert.equal(harness.pages[0].screenshots[0]?.fullPage, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Registry semantics ──────────────────────────────────────────────────────

test("BrowserSessionRegistry reuses controllers per session and sweeps idle ones", async () => {
  const closed: string[] = [];
  const factory = (sessionId: string) => ({
    sessionId,
    isOpen: true,
    idleMs: 0,
    close: async () => {
      closed.push(sessionId);
    }
  });

  const registry = new BrowserSessionRegistry(factory as never, 1000);
  const first = await registry.forSession("s1");
  const again = await registry.forSession("s1");
  assert.equal(first, again, "same session reuses the same controller");
  await registry.forSession("s2");
  assert.equal(registry.size(), 2);

  (first as any).idleMs = 9999;
  await registry.sweepIdle();
  assert.equal(registry.size(), 1);
  assert.deepEqual(closed, ["s1"]);

  const removed = await registry.closeSession("s2");
  assert.equal(removed, true);
  assert.equal(registry.size(), 0);
  assert.deepEqual(closed, ["s1", "s2"]);
});

test("BrowserSessionRegistry.closeSession is a no-op for unknown sessions", async () => {
  const registry = new BrowserSessionRegistry((() => ({})) as never, 1000);
  assert.equal(await registry.closeSession("ghost"), false);
});
