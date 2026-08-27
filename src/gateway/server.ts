import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { appConfig } from "../config/env.js";
import { app, sessionStore, runStore, chatService, searchManager, schedulerEngine } from "./app.js";
import { TelegramAdapter } from "../channels/telegram/adapter.js";
import { PidLock } from "./pidLock.js";
import { ALFRED_SERVER_PROCESS_TAG, managedProcessTag } from "./processIdentity.js";

process.title = ALFRED_SERVER_PROCESS_TAG;
const serverPidLock = new PidLock({
  lockPath: path.join(appConfig.workspaceDir, "alfred.pid"),
  processTag: ALFRED_SERVER_PROCESS_TAG
});

// Track child processes started by Alfred so they die when Alfred dies
const managedProcesses: ReturnType<typeof spawn>[] = [];
const managedRestartTimers = new Set<NodeJS.Timeout>();
let httpServer: { close: (cb?: () => void) => void } | null = null;
let shuttingDown = false;

function spawnManaged(cmd: string, label: string, maxRestarts = 0, restartAttempt = 0): void {
  const processTag = managedProcessTag(label);
  const child = spawn(cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,  // own process group so SIGTERM propagates to shell children
    shell: true,
    env: {
      ...process.env,
      ALFRED_PARENT_PID: String(process.pid),
      ALFRED_PROCESS_TAG: processTag
    }
  });
  child.once("error", (err) => {
    console.error(`[${processTag}] spawn error: ${err.message}`);
  });
  child.once("exit", (code) => {
    console.log(`[${processTag}] exited (code ${code ?? "?"})`);
    if (!shuttingDown && restartAttempt < maxRestarts) {
      const delayMs = Math.min(10_000, 1_000 * 2 ** restartAttempt);
      console.warn(
        `[${processTag}] restarting in ${delayMs}ms (${restartAttempt + 1}/${maxRestarts})`
      );
      const timer = setTimeout(() => {
        managedRestartTimers.delete(timer);
        spawnManaged(cmd, label, maxRestarts, restartAttempt + 1);
      }, delayMs);
      timer.unref?.();
      managedRestartTimers.add(timer);
    }
  });
  child.stdout?.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) console.log(`[${processTag}] ${message.slice(0, 2_000)}`);
  });
  child.stderr?.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) console.error(`[${processTag}] ${message.slice(0, 2_000)}`);
  });
  managedProcesses.push(child);
  console.log(`[${processTag}] started (pid ${child.pid ?? "?"})`);
}

let shutdownPromise: Promise<void> | undefined;

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    for (const timer of managedRestartTimers) clearTimeout(timer);
    managedRestartTimers.clear();
    try {
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
      }
    } finally {
      try {
        await serverPidLock.release();
      } catch (error) {
        console.error("[shutdown] failed to release Alfred PID lock:", error);
      }
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
  await serverPidLock.acquire();
  try {
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
      spawnManaged(appConfig.pinchtabStartCommand, "pinchtab", 3);
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
  } catch (error) {
    await serverPidLock.release();
    throw error;
  }
}

void bootstrap().catch((error) => {
  console.error("[startup] Alfred server failed to start:", error);
  process.exitCode = 1;
});
