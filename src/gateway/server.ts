import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { appConfig } from "../config/env.js";
import { app, sessionStore, runStore, chatService, searchManager } from "./app.js";
import { TelegramAdapter } from "../channels/telegram/adapter.js";

// Track child processes started by Alfred so they die when Alfred dies
const managedProcesses: ReturnType<typeof spawn>[] = [];

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
}

function handleExit(): void {
  shutdown();
  process.exit(0);
}

process.on("SIGINT", handleExit);
process.on("SIGTERM", handleExit);

async function bootstrap(): Promise<void> {
  const existingSessions = await sessionStore.listSessions(1);
  if (existingSessions.length === 0) {
    await sessionStore.createSession("Default Session");
  }

  // Auto-start Pinchtab if configured
  if (appConfig.enablePinchtab && appConfig.pinchtabStartCommand) {
    spawnManaged(appConfig.pinchtabStartCommand, "pinchtab");
  }

  serve(
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
