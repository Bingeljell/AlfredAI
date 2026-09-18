import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AlfredPaths } from "./paths.js";

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorCheck { id: string; status: DoctorStatus; message: string }
export interface DoctorReport { ok: boolean; paths: AlfredPaths; checks: DoctorCheck[] }

function parseConfig(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

async function fileMode(filePath: string): Promise<number | null> {
  return stat(filePath).then((value) => value.mode & 0o777, () => null);
}

function providerCredentialCheck(config: Record<string, string>): DoctorCheck {
  const provider = config.ALFRED_LLM_PROVIDER;
  if (!provider) return { id: "provider", status: "fail", message: "ALFRED_LLM_PROVIDER is not configured" };
  if (provider === "codex") return { id: "provider", status: "warn", message: "Codex selected; verify account separately with alfred auth status openai" };
  if (provider === "ollama" || provider === "lmstudio") return { id: "provider", status: "warn", message: `${provider} selected; live reachability was not checked` };
  const keyByProvider: Record<string, string> = {
    openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY"
  };
  const key = keyByProvider[provider];
  if (!key) return { id: "provider", status: "fail", message: `Unsupported provider: ${provider}` };
  return config[key]
    ? { id: "provider", status: "pass", message: `${provider} credential is configured (value hidden)` }
    : { id: "provider", status: "fail", message: `${key} is missing` };
}

export async function diagnoseAlfred(paths: AlfredPaths, env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({
    id: "node",
    status: major! > 22 || (major === 22 && minor! >= 18) ? "pass" : "fail",
    message: `Node ${process.versions.node}; Alfred requires >=22.18.0`
  });

  const configPath = paths.usesLegacyWorkspace ? path.join(paths.packageRoot, ".env") : path.join(paths.configDir, "config.env");
  const identityPath = paths.usesLegacyWorkspace ? path.join(paths.packageRoot, "SOUL.md") : path.join(paths.identityDir, "SOUL.md");
  const configText = await readFile(configPath, "utf8").catch(() => "");
  checks.push({ id: "config", status: configText ? "pass" : "fail", message: configText ? `Configuration found at ${configPath}` : `Configuration missing at ${configPath}` });
  const configMode = await fileMode(configPath);
  if (configMode !== null && !paths.usesLegacyWorkspace) {
    checks.push({ id: "config_permissions", status: (configMode & 0o077) === 0 ? "pass" : "fail", message: `Configuration permissions are ${configMode.toString(8)}; expected 600` });
  }
  checks.push({ id: "identity", status: await access(identityPath).then(() => "pass" as const, () => "fail" as const), message: `Identity ${await access(identityPath).then(() => "found", () => "missing")} at ${identityPath}` });
  checks.push({ id: "workspace", status: await access(paths.workspaceDir).then(() => "pass" as const, () => "fail" as const), message: `Workspace ${await access(paths.workspaceDir).then(() => "found", () => "missing")} at ${paths.workspaceDir}` });
  const accessMode = parseConfig(configText).ALFRED_ACCESS_MODE ?? "legacy default";
  checks.push({ id: "access_mode", status: accessMode === "legacy default" ? "warn" : "pass", message: `Agent access mode: ${accessMode}` });
  checks.push(providerCredentialCheck({ ...parseConfig(configText), ...env } as Record<string, string>));

  return { ok: checks.every((check) => check.status !== "fail"), paths, checks };
}
