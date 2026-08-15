/**
 * browserDom — pure, standalone DOM helpers for the persistent browser controller.
 *
 * Every function in this file is designed to run in two contexts:
 *   1. Inside the browser page, via `page.evaluate(new Function(bundle))`.
 *   2. In Node unit tests, imported directly and driven with fake DOM objects.
 *
 * This imposes two rules:
 *   - No module-level mutable state.
 *   - No closures over imported bindings. Page entry points (collectPageSnapshot,
 *     performClick, performType) may only reference functions included in the
 *     DOM bundle, which is why shared helpers are declared as standalone
 *     function declarations and composed via their `.toString()` sources.
 */

export interface InteractiveElement {
  kind: "button" | "link" | "input" | "textarea" | "select" | "checkbox" | "radio" | "other";
  label: string;
  value: string | null;
  selector: string;
  disabled: boolean;
}

export interface DomSnapshot {
  url: string;
  title: string;
  text: string;
  interactiveElements: InteractiveElement[];
  outboundLinks: string[];
}

export interface DomActionResult {
  ok: boolean;
  target: string | null;
  error: string | null;
}

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[contenteditable="true"]'
].join(",");

const MAX_INTERACTIVE_ELEMENTS = 120;
const MAX_BODY_TEXT_CHARS = 6000;
const MAX_LINKS = 60;
const MAX_POSITIONAL_DEPTH = 6;

export function compactText(input: string | null | undefined, max = 6000): string {
  return (input || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function cssEscapeIdent(value: string): string {
  const fallback = value.replace(/([\\"#.:[\] ])/g, "\\$1");
  try {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
  } catch {
    // fall through to the manual escape below
  }
  return fallback;
}

function tagOf(el: any): string {
  return ((el && el.tagName) || "div").toLowerCase();
}

function getAttribute(el: any, name: string): string | null {
  if (!el || typeof el.getAttribute !== "function") {
    return null;
  }
  const value = el.getAttribute(name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Build a stable CSS selector for an element: id first, then aria-label,
 * data-testid, name, type, and finally a positional nth-of-type path. The
 * positional path is only a snapshot — re-snapshot if the DOM changed.
 */
export function buildCssSelector(el: any): string {
  const tag = tagOf(el);
  const id = typeof el.id === "string" && el.id.length > 0 ? el.id : null;
  if (id) {
    return `${tag}#${cssEscapeIdent(id)}`;
  }
  const aria = getAttribute(el, "aria-label");
  if (aria) {
    return `${tag}[aria-label="${escapeAttrValue(aria)}"]`;
  }
  const testId = getAttribute(el, "data-testid");
  if (testId) {
    return `${tag}[data-testid="${escapeAttrValue(testId)}"]`;
  }
  const name = getAttribute(el, "name");
  if (name) {
    return `${tag}[name="${escapeAttrValue(name)}"]`;
  }
  const type = getAttribute(el, "type");
  if (type && (tag === "input" || tag === "button")) {
    return `${tag}[type="${escapeAttrValue(type)}"]`;
  }

  const parts: string[] = [];
  let node: any = el;
  let depth = 0;
  while (node && depth < MAX_POSITIONAL_DEPTH) {
    const parent = node.parentElement;
    if (!parent || parent.tagName === "BODY" || parent.tagName === "HTML") {
      break;
    }
    const sameTagSiblings = Array.from(parent.children || []).filter(
      (child: any) => child.tagName === node.tagName
    );
    const nth = sameTagSiblings.indexOf(node) + 1;
    parts.unshift(`${tagOf(node)}:nth-of-type(${nth})`);
    node = parent;
    depth += 1;
  }
  return parts.length > 0 ? parts.join(" > ") : tag;
}

function computeLabel(el: any, tag: string, type: string | null): string {
  const aria = getAttribute(el, "aria-label");
  if (aria) {
    return compactText(aria, 120);
  }
  const title = getAttribute(el, "title");
  if (title) {
    return compactText(title, 120);
  }
  if (tag === "button" || tag === "a") {
    const text = compactText(el.textContent || "", 120);
    if (text) {
      return text;
    }
  }
  const placeholder = getAttribute(el, "placeholder");
  if (placeholder) {
    return compactText(placeholder, 120);
  }
  const name = getAttribute(el, "name");
  if (name) {
    return compactText(name, 120);
  }
  if (type) {
    return `${tag} ${type}`;
  }
  return tag;
}

function computeValue(el: any, tag: string, type: string | null): string | null {
  if (tag === "select") {
    const selected = Array.from<any>(el.options || []).find((option: any) => option.selected);
    return selected ? compactText(selected.textContent || "", 120) : null;
  }
  if (type === "checkbox" || type === "radio") {
    return el.checked ? "checked" : "unchecked";
  }
  if (tag === "textarea" || tag === "input") {
    return typeof el.value === "string" && el.value.length > 0 ? compactText(el.value, 120) : null;
  }
  return null;
}

function describeElement(el: any): InteractiveElement {
  const tag = tagOf(el);
  const role = getAttribute(el, "role");
  const type = getAttribute(el, "type");

  let kind: InteractiveElement["kind"] = "other";
  if (tag === "button" || role === "button") {
    kind = "button";
  } else if (tag === "a" || role === "link") {
    kind = "link";
  } else if (tag === "textarea" || role === "textbox" || role === "searchbox") {
    kind = "textarea";
  } else if (tag === "select" || role === "combobox") {
    kind = "select";
  } else if (type === "checkbox" || role === "checkbox") {
    kind = "checkbox";
  } else if (type === "radio" || role === "radio") {
    kind = "radio";
  } else if (tag === "input") {
    kind = "input";
  }

  const disabled =
    Boolean(el.disabled) ||
    (typeof el.getAttribute === "function" && el.getAttribute("aria-disabled") === "true");

  return {
    kind,
    label: computeLabel(el, tag, type),
    value: computeValue(el, tag, type),
    selector: buildCssSelector(el),
    disabled
  };
}

/** Scan the document for interactive elements in DOM order (deduplicated). */
export function scanInteractiveElements(doc: any): InteractiveElement[] {
  const nodes = Array.from(doc.querySelectorAll(INTERACTIVE_SELECTOR) || []);
  const seen = new Set<any>();
  const elements: InteractiveElement[] = [];
  for (const node of nodes) {
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    elements.push(describeElement(node));
    if (elements.length >= MAX_INTERACTIVE_ELEMENTS) {
      break;
    }
  }
  return elements;
}

/** Full snapshot of the current page: title, compact text, elements, links. */
export function collectPageSnapshot(doc: any): DomSnapshot {
  const bodyText = doc.body && doc.body.innerText ? doc.body.innerText : "";
  const outboundLinks: string[] = [];
  for (const anchor of Array.from<any>(doc.querySelectorAll("a[href]") || [])) {
    const href = anchor.getAttribute && anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    const label = compactText(anchor.textContent || "", 80);
    outboundLinks.push(`${label} -> ${href}`);
    if (outboundLinks.length >= MAX_LINKS) {
      break;
    }
  }
  return {
    url: doc.location && doc.location.href ? String(doc.location.href) : "",
    title: compactText(doc.title || "", 180),
    text: compactText(bodyText, MAX_BODY_TEXT_CHARS),
    interactiveElements: scanInteractiveElements(doc),
    outboundLinks
  };
}

type ResolvedTarget = { el: any; label: string } | { error: string };

function findTarget(doc: any, args: { index?: number | null; text?: string | null }): ResolvedTarget {
  const elements = scanInteractiveElements(doc);

  if (args.index != null) {
    const described = elements[args.index];
    if (!described) {
      return { error: `element index ${args.index} not found (${elements.length} interactive elements available)` };
    }
    const node = doc.querySelector(described.selector);
    if (!node) {
      return { error: `element ${args.index} ("${described.label}") no longer exists in the DOM — re-snapshot` };
    }
    return { el: node, label: described.label };
  }

  if (args.text != null) {
    const normalized = String(args.text).replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) {
      return { error: "text target is empty" };
    }
    const allMatches = elements.filter((element) => element.label.toLowerCase().includes(normalized));
    const exactMatches = allMatches.filter((element) => element.label.toLowerCase() === normalized);
    const pool = exactMatches.length > 0 ? exactMatches : allMatches;
    if (pool.length === 1) {
      const node = doc.querySelector(pool[0].selector);
      if (!node) {
        return { error: `element "${pool[0].label}" no longer exists in the DOM — re-snapshot` };
      }
      return { el: node, label: pool[0].label };
    }
    if (pool.length > 1) {
      const candidates = pool
        .slice(0, 6)
        .map((element) => `"${element.label}"`)
        .join(", ");
      return { error: `ambiguous text match for "${args.text}" — candidates: ${candidates}` };
    }
    const top = elements
      .slice(0, 8)
      .map((element, index) => `[${index}] ${element.kind} "${element.label}"`)
      .join(", ");
    return { error: `no element matching "${args.text}" — top elements: ${top}` };
  }

  return { error: "provide either index or text" };
}

function scrollIntoView(el: any): void {
  if (typeof el.scrollIntoView === "function") {
    try {
      el.scrollIntoView({ block: "center" });
    } catch {
      // best-effort scroll; clicking still proceeds
    }
  }
}

function dispatchInputEvents(el: any): void {
  const win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : null;
  const EventCtor =
    (win && win.Event) || (typeof Event !== "undefined" ? Event : null);
  if (!EventCtor || typeof el.dispatchEvent !== "function") {
    return;
  }
  try {
    el.dispatchEvent(new EventCtor("input", { bubbles: true }));
    el.dispatchEvent(new EventCtor("change", { bubbles: true }));
  } catch {
    // best-effort event dispatch
  }
}

/** Click the element at `index` (from scanInteractiveElements) or matching `text`. */
export function performClick(doc: any, args: { index?: number | null; text?: string | null }): DomActionResult {
  const target = findTarget(doc, args);
  if ("error" in target) {
    return { ok: false, target: null, error: target.error };
  }
  scrollIntoView(target.el);
  if (typeof target.el.click !== "function") {
    return { ok: false, target: target.label, error: "element does not support click" };
  }
  target.el.click();
  return { ok: true, target: target.label, error: null };
}

/**
 * Type text into the element at `index` or matching `text`. Uses the native
 * value setter (React-compatible) and dispatches input/change events; supports
 * contenteditable regions as a fallback.
 */
export function performType(
  doc: any,
  args: { index?: number | null; text?: string | null; value: string }
): DomActionResult {
  const target = findTarget(doc, args);
  if ("error" in target) {
    return { ok: false, target: null, error: target.error };
  }
  const el = target.el;
  const tag = tagOf(el);
  const contentEditable =
    el.isContentEditable === true || getAttribute(el, "contenteditable") === "true";
  const isInput = tag === "input" || tag === "textarea";
  if (!isInput && !contentEditable) {
    return { ok: false, target: target.label, error: `element "${target.label}" is not typeable (${tag})` };
  }

  if (typeof el.focus === "function") {
    el.focus();
  }
  if (contentEditable) {
    el.textContent = args.value;
  } else {
    const proto = Object.getPrototypeOf(el);
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) {
      setter.set.call(el, args.value);
    } else {
      el.value = args.value;
    }
  }
  dispatchInputEvents(el);
  return { ok: true, target: target.label, error: null };
}

// ─── Page-script composition ────────────────────────────────────────────────
// The bundle is a single self-contained program: every helper's source plus a
// call to the entry point. `new Function` keeps it serializable for Playwright.

const DOM_BUNDLE = [
  `const INTERACTIVE_SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};`,
  `const MAX_INTERACTIVE_ELEMENTS = ${MAX_INTERACTIVE_ELEMENTS};`,
  `const MAX_BODY_TEXT_CHARS = ${MAX_BODY_TEXT_CHARS};`,
  `const MAX_LINKS = ${MAX_LINKS};`,
  `const MAX_POSITIONAL_DEPTH = ${MAX_POSITIONAL_DEPTH};`,
  compactText,
  escapeAttrValue,
  cssEscapeIdent,
  tagOf,
  getAttribute,
  buildCssSelector,
  computeLabel,
  computeValue,
  describeElement,
  scanInteractiveElements,
  collectPageSnapshot,
  findTarget,
  scrollIntoView,
  dispatchInputEvents,
  performClick,
  performType
]
  .map((value) => (typeof value === "function" ? value.toString() : String(value)))
  .join("\n");

/** Run a no-argument DOM entry point inside the page (or a fake page in tests). */
export async function evaluateDomScript<T>(page: any, entryPoint: string): Promise<T> {
  const source = `${DOM_BUNDLE}\nreturn (${entryPoint})(document);`;
  return page.evaluate(new Function(source)) as Promise<T>;
}

/** Run a DOM entry point that receives an args object (index/text/value). */
export async function evaluateDomScriptWithArgs<T>(
  page: any,
  entryPoint: string,
  args: unknown
): Promise<T> {
  const source = `${DOM_BUNDLE}\nreturn (${entryPoint})(document, __args);`;
  return page.evaluate(new Function("__args", source), args) as Promise<T>;
}
