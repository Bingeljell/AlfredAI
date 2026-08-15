import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCssSelector,
  collectPageSnapshot,
  compactText,
  evaluateDomScript,
  evaluateDomScriptWithArgs,
  performClick,
  performType,
  scanInteractiveElements
} from "../../src/tools/browser/browserDom.js";

// ─── Fake DOM harness ────────────────────────────────────────────────────────

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
    location: { href: opts.url ?? "" },
    body: { innerText: opts.bodyText ?? "" },
    querySelectorAll(selector: string) {
      return selector === "a[href]" ? links : interactives;
    },
    querySelector(selector: string) {
      const all = [...interactives, ...links];
      return all.find((el) => buildCssSelector(el) === selector) ?? null;
    }
  };
}

function fakePage(fn: (...args: any[]) => unknown) {
  return {
    evaluate: async (script: Function, arg?: unknown) => (arg === undefined ? script() : script(arg)),
    url: () => "https://example.com/page",
    keyboard: { press: fn }
  };
}

// ─── compactText ─────────────────────────────────────────────────────────────

test("compactText collapses whitespace and truncates to max", () => {
  assert.equal(compactText("  hello\n  world ", 100), "hello world");
  assert.equal(compactText("abcdef", 3), "abc");
  assert.equal(compactText(null, 10), "");
});

// ─── buildCssSelector ────────────────────────────────────────────────────────

test("buildCssSelector prefers id and escapes special characters", () => {
  const el = fakeEl("BUTTON", {}, { id: "btn:main" });
  assert.equal(buildCssSelector(el), "button#btn\\:main");
});

test("buildCssSelector falls back to aria-label, data-testid, name, type", () => {
  assert.equal(buildCssSelector(fakeEl("BUTTON", { "aria-label": "Close" })), 'button[aria-label="Close"]');
  assert.equal(buildCssSelector(fakeEl("A", { "data-testid": "nav-link" })), 'a[data-testid="nav-link"]');
  assert.equal(buildCssSelector(fakeEl("INPUT", { name: "email" })), 'input[name="email"]');
  assert.equal(buildCssSelector(fakeEl("BUTTON", { type: "submit" })), 'button[type="submit"]');
});

test("buildCssSelector builds a positional nth-of-type path as last resort", () => {
  const first = fakeEl("INPUT", {});
  const target = fakeEl("INPUT", {});
  const form = fakeEl("FORM", {}, { children: [first, target], parentElement: fakeEl("BODY", {}) });
  first.parentElement = form;
  target.parentElement = form;
  assert.equal(buildCssSelector(target), "input:nth-of-type(2)");
});

// ─── scanInteractiveElements ─────────────────────────────────────────────────

test("scanInteractiveElements maps kinds, labels, values, and disabled state", () => {
  const button = fakeEl("BUTTON", { type: "submit" }, { textContent: " Search " });
  const link = fakeEl("A", { href: "/docs" }, { textContent: "Docs" });
  const input = fakeEl("INPUT", { type: "text", placeholder: "Email address" }, { value: "a@b.c" });
  const checkbox = fakeEl("INPUT", { type: "checkbox" }, { checked: true });
  const textarea = fakeEl("TEXTAREA", { name: "bio" });
  const select = fakeEl("SELECT", {}, {
    options: [{ selected: true, textContent: "Option B" }, { selected: false, textContent: "Option A" }]
  });
  const disabledButton = fakeEl("BUTTON", { "aria-disabled": "true" }, { textContent: "Disabled" });
  const editable = fakeEl("DIV", { contenteditable: "true" });

  const doc = fakeDoc({ interactives: [button, link, input, checkbox, textarea, select, disabledButton, editable] });
  const elements = scanInteractiveElements(doc);

  assert.equal(elements.length, 8);
  assert.equal(elements[0]?.kind, "button");
  assert.equal(elements[0]?.label, "Search");
  assert.equal(elements[1]?.kind, "link");
  assert.equal(elements[1]?.label, "Docs");
  assert.equal(elements[2]?.kind, "input");
  assert.equal(elements[2]?.label, "Email address");
  assert.equal(elements[2]?.value, "a@b.c");
  assert.equal(elements[3]?.kind, "checkbox");
  assert.equal(elements[3]?.value, "checked");
  assert.equal(elements[4]?.kind, "textarea");
  assert.equal(elements[4]?.label, "bio");
  assert.equal(elements[5]?.kind, "select");
  assert.equal(elements[5]?.value, "Option B");
  assert.equal(elements[6]?.disabled, true);
  assert.equal(elements[7]?.kind, "other");
});

test("scanInteractiveElements deduplicates repeated nodes", () => {
  const button = fakeEl("BUTTON", {}, { textContent: "Go" });
  const doc = fakeDoc({ interactives: [button, button] });
  assert.equal(scanInteractiveElements(doc).length, 1);
});

// ─── collectPageSnapshot ─────────────────────────────────────────────────────

test("collectPageSnapshot returns title, url, compact text, and links", () => {
  const link = fakeEl("A", { href: "https://example.com/docs" }, { textContent: "Docs page" });
  const doc = fakeDoc({
    title: "Example",
    url: "https://example.com/",
    bodyText: "  line one\n   line two  ",
    links: [link]
  });
  const snapshot = collectPageSnapshot(doc);
  assert.equal(snapshot.title, "Example");
  assert.equal(snapshot.url, "https://example.com/");
  assert.equal(snapshot.text, "line one line two");
  assert.deepEqual(snapshot.outboundLinks, ["Docs page -> https://example.com/docs"]);
});

// ─── performClick ────────────────────────────────────────────────────────────

test("performClick clicks by index and by text", () => {
  const button = fakeEl("BUTTON", {}, { textContent: "Submit" });
  const doc = fakeDoc({ interactives: [button] });

  const byIndex = performClick(doc, { index: 0 });
  assert.equal(byIndex.ok, true);
  assert.equal(byIndex.target, "Submit");
  assert.equal(button.clicked, true);

  const byText = performClick(doc, { text: "Submit" });
  assert.equal(byText.ok, true);
  assert.equal(byText.target, "Submit");
});

test("performClick reports missing, ambiguous, and unknown text targets", () => {
  const buyOne = fakeEl("BUTTON", {}, { textContent: "Buy" });
  const buyTwo = fakeEl("BUTTON", {}, { textContent: "Buy" });
  const doc = fakeDoc({ interactives: [buyOne, buyTwo] });

  const missing = performClick(doc, { index: 9 });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /index 9 not found/);

  const ambiguous = performClick(doc, { text: "Buy" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /ambiguous text match/);

  const unknown = performClick(doc, { text: "Nope" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /no element matching "Nope"/);
});

// ─── performType ─────────────────────────────────────────────────────────────

test("performType fills inputs, dispatches input/change, and rejects non-typeable elements", () => {
  const input = fakeEl("INPUT", { type: "text" }, { value: "" });
  const button = fakeEl("BUTTON", {}, { textContent: "Go" });
  const doc = fakeDoc({ interactives: [input, button] });

  const result = performType(doc, { index: 0, value: "hello@example.com" });
  assert.equal(result.ok, true);
  assert.equal(input.value, "hello@example.com");
  assert.deepEqual(input.events, ["input", "change"]);

  const rejected = performType(doc, { index: 1, value: "x" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? "", /not typeable/);
});

test("performType supports contenteditable regions", () => {
  const editable = fakeEl("DIV", { contenteditable: "true" }, { isContentEditable: true, textContent: "" });
  const doc = fakeDoc({ interactives: [editable] });
  const result = performType(doc, { text: "div", value: "typed text" });
  assert.equal(result.ok, true);
  assert.equal(editable.textContent, "typed text");
});

// ─── evaluateDomScript bundle ────────────────────────────────────────────────

test("evaluateDomScript composes the page bundle and runs against a fake document", async () => {
  const originalDocument = (globalThis as any).document;
  const button = fakeEl("BUTTON", {}, { textContent: "Go" });
  (globalThis as any).document = fakeDoc({ title: "T", url: "https://example.com", interactives: [button] });
  try {
    const snapshot = await evaluateDomScript<any>(fakePage(() => {}), "collectPageSnapshot");
    assert.equal(snapshot.title, "T");
    assert.equal(snapshot.interactiveElements.length, 1);

    const clickResult = await evaluateDomScriptWithArgs<any>(fakePage(() => {}), "performClick", { index: 0 });
    assert.equal(clickResult.ok, true);
    assert.equal(button.clicked, true);
  } finally {
    if (originalDocument === undefined) {
      delete (globalThis as any).document;
    } else {
      (globalThis as any).document = originalDocument;
    }
  }
});
