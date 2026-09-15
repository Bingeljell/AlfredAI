import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AlfredPaths } from "./paths.js";

export const SETUP_PROVIDERS = ["openai", "anthropic", "gemini", "ollama", "lmstudio", "openrouter", "codex"] as const;
export type SetupProvider = typeof SETUP_PROVIDERS[number];

export interface SetupOptions {
  paths: AlfredPaths;
  name: string;
  provider: SetupProvider;
  model?: string;
  port?: number;
}

export interface SetupResult {
  home: string;
  created: string[];
  preserved: string[];
  nextSteps: string[];
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}

function defaultModel(provider: SetupProvider): string {
  switch (provider) {
    case "openrouter": return "openai/gpt-4o-mini";
    case "anthropic": return "claude-sonnet-4-5";
    case "gemini": return "gemini-2.0-flash";
    case "ollama": return "llama3.2";
    case "lmstudio": return "local-model";
    case "codex": return "gpt-5";
    default: return "gpt-4o-mini";
  }
}

function providerNextStep(provider: SetupProvider, configPath: string): string {
  if (provider === "codex") return "Run: alfred auth login openai";
  if (provider === "ollama") return "Ensure Ollama is running and the configured model is installed.";
  if (provider === "lmstudio") return "Start the LM Studio local server and load the configured model.";
  const keys: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY"
  };
  return `Add ${keys[provider]} to ${configPath} (mode 600).`;
}

async function writeOnce(filePath: string, content: string, mode: number, result: SetupResult): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode });
    await chmod(filePath, mode);
    result.created.push(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    result.preserved.push(filePath);
  }
}

export async function initializeAlfredHome(options: SetupOptions): Promise<SetupResult> {
  const name = options.name.trim();
  if (!name) throw new Error("A non-empty user name is required");
  if (!SETUP_PROVIDERS.includes(options.provider)) throw new Error(`Unsupported provider: ${options.provider}`);
  const port = options.port ?? 9001;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535");

  const result: SetupResult = { home: options.paths.alfredHome, created: [], preserved: [], nextSteps: [] };
  for (const directory of [
    options.paths.alfredHome,
    options.paths.configDir,
    options.paths.identityDir,
    options.paths.workspaceDir,
    options.paths.logsDir,
    options.paths.runDir,
    options.paths.backupsDir,
    options.paths.extensionsDir
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
  }

  const configPath = path.join(options.paths.configDir, "config.env");
  const model = options.model?.trim() || defaultModel(options.provider);
  const config = [
    "ALFRED_ENV=prod",
    `PORT=${port}`,
    `ALFRED_HOME=${quoteEnv(options.paths.alfredHome)}`,
    `ALFRED_LLM_PROVIDER=${options.provider}`,
    `ALFRED_MODEL_SMART=${quoteEnv(model)}`,
    `ALFRED_MODEL_FAST=${quoteEnv(model)}`,
    "ALFRED_SCHEDULER_ENABLED=false",
    "ALFRED_ENABLE_EXTENSIONS=true",
    "",
    "# Add only the credential required by the selected API-key provider.",
    "OPENAI_API_KEY=",
    "ANTHROPIC_API_KEY=",
    "GEMINI_API_KEY=",
    "OPENROUTER_API_KEY=",
    ""
  ].join("\n");
  await writeOnce(configPath, config, 0o600, result);

  const soulTemplate = await readFile(path.join(options.paths.packageRoot, "templates", "SOUL.md"), "utf8");
  await writeOnce(path.join(options.paths.identityDir, "SOUL.md"), soulTemplate.replaceAll("[your name]", name), 0o600, result);
  const instructionsTemplate = await readFile(path.join(options.paths.packageRoot, "templates", "INSTRUCTIONS.md"), "utf8");
  await writeOnce(path.join(options.paths.identityDir, "INSTRUCTIONS.md"), instructionsTemplate, 0o600, result);

  result.nextSteps.push(providerNextStep(options.provider, configPath));
  result.nextSteps.push("Run: alfred doctor");
  result.nextSteps.push("Run: alfred start");
  return result;
}

export async function isInitialized(paths: AlfredPaths): Promise<boolean> {
  return (await exists(path.join(paths.configDir, "config.env")))
    && (await exists(path.join(paths.identityDir, "SOUL.md")));
}
