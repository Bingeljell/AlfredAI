import { serve } from "@hono/node-server";
import { appConfig } from "../config/env.js";
import { app, sessionStore, runStore, chatService } from "./app.js";
import { TelegramAdapter } from "../channels/telegram/adapter.js";

async function bootstrap(): Promise<void> {
  const existingSessions = await sessionStore.listSessions(1);
  if (existingSessions.length === 0) {
    await sessionStore.createSession("Default Session");
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
