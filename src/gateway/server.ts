import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { appConfig } from "../config/env.js";
import { app, sessionStore, runStore, chatService, searchManager } from "./app.js";
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

function shutdown(): void {
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
    httpServer.close(() => process.exit(0));
    // Force exit if server hasn't closed within 3s
    setTimeout(() => process.exit(0), 3_000).unref();
  } else {
    process.exit(0);
  }
}

function handleExit(): void {
  shutdown();
}

process.on("SIGINT", handleExit);
process.on("SIGTERM", handleExit);
process.on("SIGHUP", handleExit);

let resolvedApiKey: string | null = null;

export function getApiKey(): string | null {
  return resolvedApiKey;
}

function ensureApiKey(): void {
  if (appConfig.apiKey) {
    resolvedApiKey = appConfig.apiKey;
    return;
  }

  const key = `alfred_${randomBytes(24).toString("hex")}`;
  const envPath = new URL("../../.env", import.meta.url).pathname;
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8");
    if (!content.includes("ALFRED_API_KEY=")) {
      writeFileSync(envPath, content.trimEnd() + `\nALFRED_API_KEY=${key}\n`);
    }
  }
  resolvedApiKey = key;
  process.env.ALFRED_API_KEY = key;

  console.log("┌──────────────────────────────────────────────────────────┐");
  console.log("│  Alfred API key generated — save this somewhere safe      │");
  console.log(`│  ${key}  │`);
  console.log("│  Required to access the web UI and API                    │");
  console.log("└──────────────────────────────────────────────────────────┘");
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

void bootstrap();
