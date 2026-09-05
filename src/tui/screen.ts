import { stripVTControlCharacters } from "node:util";
import type { RunRecord } from "../types.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);

/** Model/tool/file content is text, never terminal control sequences. */
export function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\t/g, "    ");
}

export function cellWidth(char: string): number {
  if (/^\p{Mark}+$/u.test(char)) return 0;
  const code = char.codePointAt(0) ?? 0;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char) || code >= 0x1100 && (
    code <= 0x115f || code >= 0x2329 && code <= 0x232a || code >= 0x2e80 && code <= 0xa4cf ||
    code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff ||
    code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x20000
  ) ? 2 : 1;
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  const limit = Math.max(1, width);
  for (const paragraph of plain(text).split("\n")) {
    let line = "";
    let cells = 0;
    for (const char of graphemes(paragraph)) {
      const size = cellWidth(char);
      if (cells + size > limit && line) { lines.push(line); line = ""; cells = 0; }
      if (size <= limit) { line += char; cells += size; }
    }
    lines.push(line);
  }
  return lines;
}

export function clip(text: string, width: number): string {
  return wrap(text.replace(/\n/g, " "), width)[0] ?? "";
}

export function transcript(runs: RunRecord[], width: number, details: boolean): string[] {
  const lines: string[] = [];
  const sorted = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
  for (const run of sorted) {
    const time = new Date(run.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    lines.push(`YOU  ${time}`, ...wrap(run.message, width), "", `ALFRED  ${run.status}`);
    for (const tool of run.toolCalls) {
      lines.push(...wrap(`  ${tool.status === "ok" ? "+" : "!"} ${tool.toolName} · ${tool.durationMs}ms`, width));
      if (details) lines.push(...wrap(`    ${JSON.stringify(tool.inputRedacted)}\n    ${JSON.stringify(tool.outputRedacted)}`.slice(0, 4_000), width));
    }
    if (run.assistantPreview && run.status !== "completed") lines.push(...wrap(run.assistantPreview, width));
    if (run.assistantText) lines.push(...wrap(run.assistantText, width));
    else if (run.assistantPreview) { /* The cumulative preview already represents the live answer. */ }
    else if (run.status === "queued" || run.status === "running") lines.push("Working… You can detach; Alfred keeps running.");
    if (run.cancelRequestedAt && (run.status === "running" || run.status === "queued")) lines.push("Cancellation requested…");
    if (run.artifactPaths?.length) lines.push("", "ARTIFACTS", ...run.artifactPaths.flatMap((file) => wrap(`  ${file}`, width)));
    lines.push("", "─".repeat(Math.max(1, width)), "");
  }
  return lines;
}

export class Composer {
  value = "";
  cursor = 0;

  insert(text: string): void {
    const chars = graphemes(this.value);
    const inserted = graphemes(plain(text.replace(/\r\n?/g, "\n"))).slice(0, Math.max(0, 50_000 - chars.length));
    chars.splice(this.cursor, 0, ...inserted);
    this.cursor += inserted.length;
    this.value = chars.join("");
  }

  backspace(): void {
    if (!this.cursor) return;
    const chars = graphemes(this.value);
    chars.splice(--this.cursor, 1);
    this.value = chars.join("");
  }

  delete(): void {
    const chars = graphemes(this.value);
    chars.splice(this.cursor, 1);
    this.value = chars.join("");
  }

  clear(): string {
    const value = this.value;
    this.value = "";
    this.cursor = 0;
    return value;
  }

  display(): string {
    const chars = graphemes(this.value);
    chars.splice(this.cursor, 0, "▏");
    return chars.join("");
  }
}
