import type { WatchSnapshot, WatchSnapshotStatus } from "./types.js";

export const HERDR_SNAPSHOT_LINE_LIMIT = 15;

export const HERDR_WATCH_STATUSES = [
  "RUNNING",
  "TASK_COMPLETE",
  "IDLE_WAITING_INPUT",
  "ERROR",
] as const;

export type HerdrWatchStatus = WatchSnapshotStatus;

export interface HerdrTerminalReading {
  lifecycle?: unknown;
  exitCode?: unknown;
  stdout: string;
}

export function buildHerdrTerminalSnapshot(
  taskId: string,
  metadata: unknown,
  output: unknown,
): WatchSnapshot {
  const stdout = extractText(output) || extractText(metadata);
  const exitCode = extractExitCode(metadata) ?? extractExitCode(output) ?? null;
  const lifecycle = extractLifecycle(metadata) ?? extractLifecycle(output);
  return {
    taskId,
    status: detectHerdrStatus({ lifecycle, exitCode, stdout }),
    exitCode,
    stdout: tailStdout(stdout),
  };
}

export function detectHerdrStatus(reading: HerdrTerminalReading): HerdrWatchStatus {
  const lines = reading.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lifecycle = normalize(reading.lifecycle);

  if (reading.exitCode !== null && reading.exitCode !== undefined && reading.exitCode !== 0) {
    return "ERROR";
  }
  if (lines.some((line) => /^(?:\[?)(?:ERROR|ERR|FAILED|FAILURE|CRASHED|PANIC)(?:\]?)(?:\b|\s*:)/i.test(line))) {
    return "ERROR";
  }

  if (lines.some((line) => /\bTASK[ _-]+COMPLETE(?:D)?\b/i.test(line) || /^✅\s*(?:TASK\s*)?COMPLETE(?:D)?\b/i.test(line))) {
    return "TASK_COMPLETE";
  }
  if (lines.some((line) => /\b(?:IDLE[ _-]+WAITING[ _-]+INPUT|WAITING[ _-]+FOR[ _-]+INPUT|AWAITING[ _-]+INPUT)\b/i.test(line))) {
    return "IDLE_WAITING_INPUT";
  }

  if (["error", "failed", "failure", "crashed", "panic", "missing", "not_found"].includes(lifecycle)) {
    return "ERROR";
  }
  if (["complete", "completed", "done", "success", "succeeded"].includes(lifecycle)) {
    return "TASK_COMPLETE";
  }
  if (["idle", "blocked", "waiting", "waiting_input", "waiting_for_input"].includes(lifecycle)) {
    return "IDLE_WAITING_INPUT";
  }

  if (reading.exitCode === 0) {
    return "TASK_COMPLETE";
  }
  return "RUNNING";
}

export function tailStdout(value: string, limit = HERDR_SNAPSHOT_LINE_LIMIT): string[] {
  const lines = stripAnsi(value).split(/\r?\n/).map((line) => line.trimEnd());
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.slice(-Math.max(1, limit));
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  const candidate = findField(value, ["stdout", "output", "text", "content"]);
  if (typeof candidate === "string") return candidate;
  if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) {
    return candidate.join("\n");
  }
  return "";
}

function extractExitCode(value: unknown): number | null | undefined {
  const candidate = findField(value, ["exitCode", "exit_code"]);
  if (candidate === null) return null;
  if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  if (typeof candidate === "string" && /^-?\d+$/.test(candidate)) return Number(candidate);
  return undefined;
}

function extractLifecycle(value: unknown): string | undefined {
  const candidate = findField(value, ["status", "state", "lifecycle", "agent_status"]);
  return typeof candidate === "string" ? candidate : undefined;
}

function findField(value: unknown, names: string[], depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findField(item, names, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const name of names) {
    if (name in record) return record[name];
  }
  for (const nested of Object.values(record)) {
    const found = findField(nested, names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function normalize(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
}
