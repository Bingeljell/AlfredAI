import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { WatchDefinition } from "../types.js";
import type { ProbeResult, SchedulerProbe } from "./types.js";

export class FileExistsProbe implements SchedulerProbe<Extract<WatchDefinition, { type: "file_exists" }>> {
  constructor(private readonly workspaceDir: string) {}

  async probe(definition: Extract<WatchDefinition, { type: "file_exists" }>, previousDigest?: string): Promise<ProbeResult> {
    const fullPath = safePath(this.workspaceDir, definition.relativePath);
    if (!fullPath) return result("failed", "unsafe_path", "The watched path is not safe.", true, previousDigest);
    try {
      const metadata = await stat(fullPath);
      const valueDigest = digest({ exists: true, isFile: metadata.isFile(), size: metadata.size, mtimeMs: metadata.mtimeMs });
      return result("completed", valueDigest, "The watched file exists.", true, previousDigest);
    } catch (error) {
      if (isMissing(error)) return result("missing", digest({ exists: false }), "The watched file does not exist.", true, previousDigest);
      return result("unknown", "file_probe_error", "The watched file could not be inspected.", false, previousDigest, "file_probe_error");
    }
  }
}

function safePath(root: string, relativePath: string): string | undefined {
  if (relativePath.includes("\0") || path.isAbsolute(relativePath)) return undefined;
  const full = path.resolve(root, relativePath);
  const relative = path.relative(root, full);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? undefined : full;
}

function result(status: ProbeResult["status"], valueDigest: string, summary: string, terminal: boolean, previousDigest?: string, errorCode?: string): ProbeResult {
  return { status, digest: valueDigest, summary, terminal, changed: previousDigest !== undefined && previousDigest !== valueDigest, errorCode };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

