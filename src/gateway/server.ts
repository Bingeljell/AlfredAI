import { serve } from "@hono/node-server";
import { appConfig } from "../config/env.js";
import { app, sessionStore } from "./app.js";

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
}

void bootstrap();
