import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { CodexAccountService, type OpenAiLoginMode, type OpenAiLoginProgress, type OpenAiLoginStart } from "../src/provider/codex/accountService.js";
import { migrateAlfredHome } from "../src/config/homeMigration.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;

function usage(): never {
  throw new Error("Usage: pnpm alfred tui [--session ID] [--url URL] | pnpm alfred migrate home [--to PATH] [--source-workspace PATH] [--apply] | pnpm alfred auth login openai [--device-code] [--timeout-ms <ms>] | pnpm alfred auth status openai | pnpm alfred auth logout openai");
}

type CliAccountService = Pick<CodexAccountService, "startLogin" | "waitForLogin" | "readAccount" | "logout" | "close">;

export interface AlfredCliOptions {
  service?: CliAccountService;
  write?: (message: string) => void;
  timeoutMs?: number;
  signalSource?: NodeJS.Process;
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
