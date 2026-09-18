import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../tools/types.js";
import { ExtensionManifestSchema, type ExtensionActivation, type ExtensionManifest, type ExtensionSummary } from "./schema.js";

interface ExtensionModule {
  execute?: (input: Record<string, unknown>, context: ToolContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

const execFileAsync = promisify(execFile);

export interface ExtensionInspection {
  manifest: ExtensionManifest;
  digest: string;
  directory: string;
  entryPath: string;
}

function safeName(name: string): string {
  return ExtensionManifestSchema.shape.name.parse(name);
}

async function atomicWrite(filePath: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function digestDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "enabled.json") continue;
      const entryRelative = path.join(relative, entry.name);
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Extension trees cannot contain symbolic links");
      if (entry.isDirectory()) await visit(fullPath, entryRelative);
      else if (entry.isFile()) {
        hash.update(entryRelative).update("\0").update(await readFile(fullPath)).update("\0");
      }
    }
  }
  await visit(directory, "");
  return hash.digest("hex");
}

function compatible(range: string, version: string): boolean {
  if (range === version) return true;
  const [major, minor] = version.split(".");
  return range === `${major}.${minor}.x`;
}

export class ExtensionManager {
  constructor(private readonly extensionsDir: string, private readonly alfredVersion = "0.1.0") {}

  private directory(name: string): string {
    return path.join(this.extensionsDir, safeName(name));
  }

  async inspect(name: string): Promise<ExtensionInspection> {
    const directory = this.directory(name);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Extension directory must be a real directory");
    const manifestPath = path.join(directory, "manifest.json");
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Extension manifest must be a regular file");
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = ExtensionManifestSchema.parse(JSON.parse(manifestText));
    if (manifest.name !== name) throw new Error("Extension directory and manifest names must match");
    if (!compatible(manifest.alfredVersion, this.alfredVersion)) {
      throw new Error(`Extension requires Alfred ${manifest.alfredVersion}; running ${this.alfredVersion}`);
    }
    const entryPath = path.join(directory, manifest.entry);
    const entryStat = await lstat(entryPath);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error("Extension entry must be a regular JavaScript file");
    const digest = await digestDirectory(directory);
    return { manifest, digest, directory, entryPath };
  }

  async validateSyntax(name: string): Promise<ExtensionInspection> {
    const inspection = await this.inspect(name);
    await execFileAsync(process.execPath, ["--check", inspection.entryPath], { timeout: 10_000 });
    const source = await readFile(inspection.entryPath, "utf8");
    if (!/export\s+(?:async\s+)?function\s+execute\s*\(/.test(source) && !/export\s+(?:const|let|var)\s+execute\s*=/.test(source)) {
      throw new Error("Extension entry must export an execute(input, context) function");
    }
    return inspection;
  }

  async enable(name: string, confirmed: boolean): Promise<ExtensionInspection> {
    if (!confirmed) throw new Error("Explicit confirmation is required to enable extension code");
    const inspection = await this.validateSyntax(name);
    const activation: ExtensionActivation = {
      schemaVersion: 1,
      approvedDigest: inspection.digest,
      enabledAt: new Date().toISOString(),
      capabilities: inspection.manifest.capabilities
    };
    await atomicWrite(path.join(inspection.directory, "enabled.json"), `${JSON.stringify(activation, null, 2)}\n`);
    return inspection;
  }

  async disable(name: string): Promise<void> {
    await rm(path.join(this.directory(name), "enabled.json"), { force: true });
  }

  async scaffold(name: string, description: string): Promise<string> {
    const normalized = safeName(name);
    const directory = this.directory(normalized);
    await mkdir(this.extensionsDir, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const manifest: ExtensionManifest = {
      schemaVersion: 1,
      name: normalized,
      version: "0.1.0",
      description: description.trim() || `${normalized} Alfred extension`,
      entry: "index.js",
      inputHint: "{}",
      alfredVersion: "0.1.x",
      capabilities: []
    };
    await atomicWrite(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await atomicWrite(path.join(directory, "index.js"), "export async function execute(input) {\n  return { ok: true, input };\n}\n");
    return directory;
  }

  async write(name: string, manifest: ExtensionManifest, entrySource: string): Promise<ExtensionInspection> {
    const normalized = safeName(name);
    if (manifest.name !== normalized) throw new Error("Extension name must match its manifest");
    const parsed = ExtensionManifestSchema.parse(manifest);
    const directory = this.directory(normalized);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(directory, "manifest.json"), `${JSON.stringify(parsed, null, 2)}\n`);
    await atomicWrite(path.join(directory, parsed.entry), entrySource);
    await this.disable(normalized);
    return this.validateSyntax(normalized);
  }

  async list(): Promise<ExtensionSummary[]> {
    const names = await readdir(this.extensionsDir).catch(() => [] as string[]);
    const summaries: ExtensionSummary[] = [];
    for (const name of names.sort()) {
      try {
        const inspection = await this.inspect(name);
        const activation = await readFile(path.join(inspection.directory, "enabled.json"), "utf8")
          .then((raw) => JSON.parse(raw) as ExtensionActivation)
          .catch(() => null);
        summaries.push({
          name,
          version: inspection.manifest.version,
          description: inspection.manifest.description,
          capabilities: inspection.manifest.capabilities,
          digest: inspection.digest,
          state: activation ? activation.approvedDigest === inspection.digest ? "enabled" : "stale" : "disabled"
        });
      } catch (error) {
        summaries.push({ name, version: null, description: null, capabilities: [], digest: null, state: "invalid", error: error instanceof Error ? error.message.slice(0, 300) : "Invalid extension" });
      }
    }
    return summaries;
  }

  async discoverEnabled(): Promise<Map<string, ToolDefinition>> {
    const tools = new Map<string, ToolDefinition>();
    for (const summary of await this.list()) {
      if (summary.state !== "enabled") continue;
      try {
        const inspection = await this.inspect(summary.name);
        const loaded = await import(`${pathToFileURL(inspection.entryPath).href}?digest=${inspection.digest}`) as ExtensionModule;
        if (typeof loaded.execute !== "function") continue;
        const inputSchema = z.record(z.string(), z.unknown());
        const definition: ToolDefinition<typeof inputSchema> = {
          name: inspection.manifest.name,
          description: inspection.manifest.description,
          inputSchema,
          inputHint: inspection.manifest.inputHint,
          requiresApproval: true,
          execute: async (input, context) => loaded.execute!(input, context)
        };
        tools.set(inspection.manifest.name, definition);
      } catch {
        // One broken extension must not prevent Alfred from starting.
      }
    }
    return tools;
  }
}
