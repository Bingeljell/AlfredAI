import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { CodexAccountService, type OpenAiLoginMode, type OpenAiLoginProgress, type OpenAiLoginStart } from "../src/provider/codex/accountService.js";
import { migrateAlfredHome } from "../src/config/homeMigration.js";
import { diagnoseAlfred } from "../src/config/doctor.js";
import { resolveAlfredPaths } from "../src/config/paths.js";
import { initializeAlfredHome, SETUP_PROVIDERS, type SetupProvider } from "../src/config/setup.js";
import { ExtensionManager } from "../src/extensions/manager.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;

function usage(): never {
  throw new Error("Usage: alfred setup [--name NAME] [--provider PROVIDER] [--model MODEL] [--home PATH] | alfred doctor [--home PATH] [--json] | alfred tools <list|create|test|enable|disable> | alfred start | alfred tui [--session ID] [--url URL] | alfred migrate home [--to PATH] [--source-workspace PATH] [--apply] | alfred auth login openai [--device-code] [--timeout-ms <ms>] | alfred auth status openai | alfred auth logout openai");
}

type CliAccountService = Pick<CodexAccountService, "startLogin" | "waitForLogin" | "readAccount" | "logout" | "close">;

export interface AlfredCliOptions {
  service?: CliAccountService;
  write?: (message: string) => void;
  timeoutMs?: number;
  signalSource?: NodeJS.Process;
  prompt?: (question: string) => Promise<string>;
}

async function runSetup(args: string[], options: AlfredCliOptions): Promise<number> {
  const allowed = new Set(["--name", "--provider", "--model", "--home", "--port"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]!)) throw new Error(`Unknown setup option: ${args[index]}`);
  }
  let closePrompt = (): void => undefined;
  let prompt = options.prompt;
  if (!prompt && (!optionValue(args, "--name") || !optionValue(args, "--provider"))) {
    if (!process.stdin.isTTY) throw new Error("Non-interactive setup requires --name and --provider");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    prompt = (question) => terminal.question(question);
    closePrompt = () => terminal.close();
  }
  try {
    const name = optionValue(args, "--name") ?? await prompt!("Your name: ");
    const providerValue = (optionValue(args, "--provider") ?? await prompt!(`Provider (${SETUP_PROVIDERS.join("/")}): `)).trim().toLowerCase();
    if (!SETUP_PROVIDERS.includes(providerValue as SetupProvider)) throw new Error(`Unsupported provider: ${providerValue}`);
    const basePaths = resolveAlfredPaths();
    const targetHome = path.resolve(optionValue(args, "--home") ?? basePaths.alfredHome);
    const paths = resolveAlfredPaths({
      env: { ALFRED_HOME: targetHome, ALFRED_PACKAGE_MODE: "true" },
      packageRoot: basePaths.packageRoot
    });
    const result = await initializeAlfredHome({
      paths,
      name,
      provider: providerValue as SetupProvider,
      model: optionValue(args, "--model"),
      port: optionValue(args, "--port") ? Number(optionValue(args, "--port")) : undefined
    });
    const write = options.write ?? ((message: string) => console.log(message));
    write(`Alfred home: ${result.home}`);
    write(`Created ${result.created.length} file(s); preserved ${result.preserved.length} existing file(s).`);
    for (const step of result.nextSteps) write(step);
    return 0;
  } finally {
    closePrompt();
  }
}

async function runDoctor(args: string[], write: (message: string) => void): Promise<number> {
  const allowed = new Set(["--home", "--json"]);
  for (let index = 0; index < args.length; index += 1) {
    if (!allowed.has(args[index]!)) throw new Error(`Unknown doctor option: ${args[index]}`);
    if (args[index] === "--home") index += 1;
  }
  const home = optionValue(args, "--home");
  const basePaths = resolveAlfredPaths();
  const paths = home
    ? resolveAlfredPaths({ env: { ALFRED_HOME: path.resolve(home), ALFRED_PACKAGE_MODE: "true" }, packageRoot: basePaths.packageRoot })
    : basePaths;
  const report = await diagnoseAlfred(paths);
  if (args.includes("--json")) write(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) write(`${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.message}`);
    write(report.ok ? "Alfred is ready to start." : "Alfred needs attention before startup.");
  }
  return report.ok ? 0 : 1;
}

async function runTools(args: string[], write: (message: string) => void): Promise<number> {
  const action = args[0];
  const paths = resolveAlfredPaths();
  const manager = new ExtensionManager(paths.extensionsDir);
  if (action === "list") {
    write(JSON.stringify(await manager.list(), null, 2));
    return 0;
  }
  const name = args[1];
  if (!name) throw new Error(`alfred tools ${action ?? "<action>"} requires an extension name`);
  if (action === "create") {
    const options = args.slice(2);
    if (options.length > 0 && (options.length !== 2 || options[0] !== "--description")) {
      throw new Error(`Unknown tools create option: ${options[0]}`);
    }
    const directory = await manager.scaffold(name, optionValue(options, "--description") ?? "");
    write(`Created disabled extension scaffold at ${directory}`);
    write(`Review it, run: alfred tools test ${name}, then: alfred tools enable ${name} --yes`);
    return 0;
  }
  if (action === "test") {
    const inspection = await manager.validateSyntax(name);
    write(JSON.stringify({ valid: true, name, digest: inspection.digest, capabilities: inspection.manifest.capabilities }, null, 2));
    return 0;
  }
  if (action === "enable") {
    if (!args.includes("--yes")) {
      const inspection = await manager.inspect(name);
      write(JSON.stringify({ enabled: false, name, digest: inspection.digest, capabilities: inspection.manifest.capabilities }, null, 2));
      throw new Error("Review this exact digest and capability list, then repeat with --yes");
    }
    const inspection = await manager.enable(name, true);
    write(JSON.stringify({ enabled: true, name, digest: inspection.digest, capabilities: inspection.manifest.capabilities, restartRequired: true }, null, 2));
    return 0;
  }
  if (action === "disable") {
    await manager.disable(name);
    write(JSON.stringify({ enabled: false, name, restartRequired: true }, null, 2));
    return 0;
  }
  throw new Error(`Unknown tools action: ${action}`);
}

function parseTimeout(args: string[]): number {
  const index = args.indexOf("--timeout-ms");
  if (index < 0) return DEFAULT_LOGIN_TIMEOUT_MS;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 1_000) throw new Error("--timeout-ms must be at least 1000 milliseconds");
  return value;
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function runHomeMigration(args: string[], write: (message: string) => void): Promise<number> {
  const allowed = new Set(["--to", "--source-workspace", "--apply"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!allowed.has(argument)) throw new Error(`Unknown migration option: ${argument}`);
    if (argument !== "--apply") index += 1;
  }
  const targetHome = path.resolve(optionValue(args, "--to") ?? process.env.ALFRED_HOME ?? path.join(os.homedir(), ".alfred"));
  const sourceWorkspace = optionValue(args, "--source-workspace");
  const plan = await migrateAlfredHome({
    sourceRoot: process.cwd(),
    targetHome,
    sourceWorkspace: sourceWorkspace ? path.resolve(sourceWorkspace) : undefined,
    apply: args.includes("--apply")
  });
  write(JSON.stringify(plan, null, 2));
  if (plan.dryRun) write("Dry run only. Re-run with --apply to copy data; the source checkout will remain unchanged.");
  else write(`Migration copied private state to ${plan.targetHome}. Set ALFRED_HOME to this path before restarting Alfred.`);
  return 0;
}

function printLoginInstructions(login: OpenAiLoginStart, write: (message: string) => void): void {
  if (login.mode === "device-code") {
    write(`Open ${login.verificationUrl} and enter the one-time code ${login.userCode}.`);
  } else {
    write(`Open this URL in a browser to sign in with ChatGPT:\n${login.authorizationUrl}`);
  }
  write("Waiting for Codex App Server to confirm completion. Press Ctrl-C to cancel.");
}

function printLoginResult(progress: OpenAiLoginProgress, write: (message: string) => void): number {
  if (progress.status === "completed") {
    write("ChatGPT login completed.");
    return 0;
  }
  if (progress.status === "cancelled") {
    write(`ChatGPT login cancelled${progress.error ? `: ${progress.error}` : "."}`);
    return 130;
  }
  write(`ChatGPT login failed${progress.error ? `: ${progress.error}` : "."}`);
  return 1;
}

export async function runCli(args: string[], options: AlfredCliOptions = {}): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    (options.write ?? ((message: string) => console.log(message)))("Usage: alfred setup | alfred doctor | alfred tools <list|create|test|enable|disable> | alfred start | alfred tui | alfred migrate home | alfred auth <login|status|logout> openai");
    return 0;
  }
  if (args[0] === "setup") return runSetup(args.slice(1), options);
  if (args[0] === "doctor") return runDoctor(args.slice(1), options.write ?? ((message: string) => console.log(message)));
  if (args[0] === "tools") return runTools(args.slice(1), options.write ?? ((message: string) => console.log(message)));
  if (args[0] === "start") {
    await import("../src/gateway/server.js");
    return 0;
  }
  if (args[0] === "tui") return (await import("../src/tui/index.js")).runTui(args.slice(1));
  if (args[0] === "migrate" && args[1] === "home") {
    return runHomeMigration(args.slice(2), options.write ?? ((message: string) => console.log(message)));
  }
  if (args[0] !== "auth" || !["login", "status", "logout"].includes(args[1] ?? "") || args[2] !== "openai") usage();

  const service = options.service ?? new CodexAccountService();
  const write = options.write ?? ((message: string) => console.log(message));
  const signalSource = options.signalSource ?? process;
  try {
    if (args[1] === "login") {
      const mode: OpenAiLoginMode = args.includes("--device-code") ? "device-code" : "browser";
      const controller = new AbortController();
      const onSigint = (): void => {
        if (!controller.signal.aborted) {
          write("Cancellation requested; asking Codex App Server to cancel the login...");
          controller.abort();
        }
      };
      signalSource.once("SIGINT", onSigint);
      try {
        const login = await service.startLogin(mode);
        printLoginInstructions(login, write);
        const progress = await service.waitForLogin(login.loginId, {
          timeoutMs: options.timeoutMs ?? parseTimeout(args),
          signal: controller.signal
        });
        return printLoginResult(progress, write);
      } finally {
        signalSource.removeListener("SIGINT", onSigint);
      }
    }
    if (args[1] === "status") {
      write(JSON.stringify(await service.readAccount(), null, 2));
      return 0;
    }
    await service.logout();
    write(JSON.stringify({ ok: true }, null, 2));
    return 0;
  } finally {
    await service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Alfred CLI failed");
    process.exitCode = 1;
  }
}
