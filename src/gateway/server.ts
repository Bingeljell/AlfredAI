import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { appConfig } from "../config/env.js";
import { app, sessionStore, runStore, chatService, searchManager, schedulerEngine } from "./app.js";
import { TelegramAdapter } from "../channels/telegram/adapter.js";

// Track child processes started by Alfred so they die when Alfred dies
const managedProcesses: ReturnType<typeof spawn>[] = [];
let httpServer: { close: (cb?: () => void) => void } | null = null;

function spawnManaged(cmd: string, label: string): void {
  const child = spawn(cmd, {
    stdio: "ignore",
    detached: true,  // own process group so SIGTERM propagates to shell children
    shell: true
  });
  child.once("error", (err) => {
    console.error(`[${label}] spawn error: ${err.message}`);
  });
  child.once("exit", (code) => {
    console.log(`[${label}] exited (code ${code ?? "?"})`);
  });
  managedProcesses.push(child);
  console.log(`[${label}] started (pid ${child.pid ?? "?"})`);
}

let shutdownPromise: Promise<void> | undefined;

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (appConfig.schedulerEnabled) await schedulerEngine.stop();
    searchManager.shutdown();
    for (const child of managedProcesses) {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // Already exited
      }
    }
    if (httpServer) {
      await Promise.race([
        new Promise<void>((resolve) => httpServer?.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000))
      ]);
      process.exit(0);
    } else {
      process.exit(0);
    }
  })();
  return shutdownPromise;
}

function handleExit(): void {
  void shutdown();
}

process.on("SIGINT", handleExit);
process.on("SIGTERM", handleExit);
process.on("SIGHUP", handleExit);

let resolvedApiKey: string | null = null;

export function getApiKey(): string | null {
  return resolvedApiKey;
}

function ensureApiKey(): void {
  // 1. An explicitly configured key (env / .env) always wins.
  if (appConfig.apiKey) {
    resolvedApiKey = appConfig.apiKey;
    return;
  }

  const credentialsPath = path.join(appConfig.workspaceDir, "api-key");

  // 2. Reuse a key generated on a previous run.
  if (existsSync(credentialsPath)) {
    const stored = readFileSync(credentialsPath, "utf8").trim();
    if (stored) {
      resolvedApiKey = stored;
      process.env.ALFRED_API_KEY = stored;
      return;
    }
  }

  // 3. First run: generate and persist to a dedicated credentials file — never
  //    .env — and point the operator at the file rather than printing the secret
  //    to stdout, which would otherwise land in logs/alfred.log.
  const key = `alfred_${randomBytes(24).toString("hex")}`;
  mkdirSync(path.dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, key + "\n", { mode: 0o600 });
  try {
    chmodSync(credentialsPath, 0o600);
  } catch {
    // best effort — non-POSIX filesystems may not support chmod
  }
  resolvedApiKey = key;
  process.env.ALFRED_API_KEY = key;

  console.log("[startup] Generated an Alfred API key (required for the web UI and API).");
  console.log(`[startup] Stored at ${credentialsPath} (mode 600). Retrieve it with: cat "${credentialsPath}"`);
}

async function bootstrap(): Promise<void> {
  ensureApiKey();

  const recovered = await runStore.recoverInterruptedRuns();
  if (recovered > 0) {
    console.log(`[startup] Marked ${recovered} interrupted run(s) as failed.`);
  }

  const existingSessions = await sessionStore.listSessions(1);
  if (existingSessions.length === 0) {
    await sessionStore.createSession("Default Session");
  }

  // Auto-start managed services
  if (appConfig.searxngStartCommand) {
    spawnManaged(appConfig.searxngStartCommand, "searxng");
  }
  if (appConfig.enablePinchtab && appConfig.pinchtabStartCommand) {
    spawnManaged(appConfig.pinchtabStartCommand, "pinchtab");
  }

  httpServer = serve(
    {
      fetch: app.fetch,
      port: appConfig.port
    },
    (info: { port: number }) => {
      console.log(`Alfred gateway listening on http://localhost:${info.port}`);
    }
  );

  if (appConfig.telegramBotToken) {
    if (appConfig.telegramAllowedUserIds.length === 0) {
      console.warn(
        "[telegram] TELEGRAM_BOT_TOKEN is set but TELEGRAM_ALLOWED_USER_IDS is empty — refusing to start the bot (fail closed). Add allowed numeric user IDs to enable Telegram."
      );
    } else {
      const telegram = new TelegramAdapter(
        appConfig.telegramBotToken,
        chatService,
        sessionStore,
        runStore,
        appConfig.workspaceDir,
        appConfig.telegramAllowedUserIds
      );
      await telegram.start();
    }
  }

  if (appConfig.schedulerEnabled) {
    await schedulerEngine.start();
    console.log("[scheduler] autonomous wake/reminder engine started");
  }
}

void bootstrap();
