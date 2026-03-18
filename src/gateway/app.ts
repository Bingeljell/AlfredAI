import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { appConfig } from "../config/env.js";
import { SessionStore } from "../memory/sessionStore.js";
import { RunStore } from "../runs/runStore.js";
import { SearxngProvider } from "../tools/search/providers/searxngProvider.js";
import { BraveProvider } from "../tools/search/providers/braveProvider.js";
import { BrightDataProvider } from "../tools/search/providers/brightDataProvider.js";
import { SearchManager } from "../tools/search/searchManager.js";
import { InMemoryQueue } from "../workers/inMemoryQueue.js";
import { ChatService } from "../services/chatService.js";
import { ChannelSessionStore } from "../channels/telegram/channelSessionStore.js";

const SessionPostSchema = z.object({
  action: z.enum(["create", "list"]).default("list"),
  name: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const ChatTurnSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  requestJob: z.boolean().optional()
});

const app = new Hono();

const sessionStore = new SessionStore(appConfig.workspaceDir);
const runStore = new RunStore(appConfig.workspaceDir);
const queue = new InMemoryQueue(appConfig.concurrency);

const searxngProvider = new SearxngProvider(
  appConfig.searxngBaseUrl,
  appConfig.searxngSearchPath,
  appConfig.searxngHealthPath
);
const brightDataProvider = appConfig.brightDataSearchApiKey && appConfig.brightDataSearchZone
  ? new BrightDataProvider({
      apiKey: appConfig.brightDataSearchApiKey,
      baseUrl: appConfig.brightDataSearchBaseUrl,
      searchPath: appConfig.brightDataSearchPath,
      zone: appConfig.brightDataSearchZone,
      engine: appConfig.brightDataSearchEngine,
      country: appConfig.brightDataSearchCountry,
      timeoutMs: appConfig.brightDataSearchTimeoutMs
    })
  : undefined;
const braveProvider = appConfig.braveSearchApiKey ? new BraveProvider(appConfig.braveSearchApiKey) : undefined;

const searchManager = new SearchManager({
  primary: searxngProvider,
  fallback: brightDataProvider ?? braveProvider,
  primaryStartCommand: appConfig.searxngStartCommand || undefined,
  maxResults: appConfig.searchMaxResults,
  startupTimeoutMs: appConfig.searxngStartTimeoutMs,
  retryIntervalMs: appConfig.searxngRetryIntervalMs,
  primaryHealthRetries: appConfig.searxngHealthRetries,
  primaryHealthRetryDelayMs: appConfig.searxngHealthRetryDelayMs,
  primaryHealthGraceMs: appConfig.searxngHealthGraceMs
});

const chatService = new ChatService({
  sessionStore,
  runStore,
  searchManager,
  queue,
  workspaceDir: appConfig.workspaceDir,
  searchMaxResults: appConfig.searchMaxResults,
  fastScrapeCount: appConfig.fastScrapeCount,
  enablePlaywright: appConfig.enablePlaywright,
  maxSteps: appConfig.runMaxSteps,
  openAiApiKey: appConfig.openAiApiKey,
  subReactMaxPages: appConfig.subReactMaxPages,
  subReactBrowseConcurrency: appConfig.subReactBrowseConcurrency,
  subReactBatchSize: appConfig.subReactBatchSize,
  subReactLlmMaxCalls: appConfig.subReactLlmMaxCalls,
  subReactMinConfidence: appConfig.subReactMinConfidence,
  agentMaxDurationMs: appConfig.agentMaxDurationMs,
  agentMaxToolCalls: appConfig.agentMaxToolCalls,
  agentMaxParallelTools: appConfig.agentMaxParallelTools,
  agentPlannerMaxCalls: appConfig.agentPlannerMaxCalls,
  agentObservationWindow: appConfig.agentObservationWindow,
  agentDiminishingThreshold: appConfig.agentDiminishingThreshold
});

app.get("/health", (c) => {
  return c.json({
    ok: true,
    env: appConfig.env,
    timestamp: new Date().toISOString()
  });
});

app.get("/v1/providers/status", async (c) => {
  const status = await searchManager.getProviderStatus();
  return c.json(status);
});

app.post("/v1/sessions", async (c) => {
  const json = await c.req.json();
  const payload = SessionPostSchema.parse(json);

  if (payload.action === "create") {
    const session = await sessionStore.createSession(payload.name, payload.metadata);
    return c.json({ session });
  }

  const sessions = await sessionStore.listSessions(payload.limit);
  return c.json({ sessions });
});

app.get("/v1/sessions", async (c) => {
  const limit = Number(c.req.query("limit") || "50");
  const sessions = await sessionStore.listSessions(limit);
  return c.json({ sessions });
});

app.post("/v1/chat/turn", async (c) => {
  const json = await c.req.json();
  const payload = ChatTurnSchema.parse(json);

  const response = await chatService.handleTurn(payload);
  return c.json(response);
});

app.get("/v1/runs", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  const limit = Number(c.req.query("limit") || "20");
  const runs = await runStore.listRuns(sessionId, limit);
  return c.json({ runs });
});

app.get("/v1/runs/:runId", async (c) => {
  const run = await runStore.getRun(c.req.param("runId"));
  if (!run) {
    return c.json({ error: "Run not found" }, 404);
  }

  const events = await runStore.listRunEvents(run);
  return c.json({ run, events });
});

app.post("/v1/runs/:runId/cancel", async (c) => {
  try {
    const result = await chatService.requestRunCancellation(c.req.param("runId"));
    return c.json(result);
  } catch {
    return c.json({ error: "Run not found" }, 404);
  }
});

app.get("/v1/runs/:runId/export", async (c) => {
  try {
    const bundle = await runStore.buildDebugExport(c.req.param("runId"));
    return c.json(bundle);
  } catch {
    return c.json({ error: "Run not found" }, 404);
  }
});

app.get("/v1/channels", async (c) => {
  const store = new ChannelSessionStore(appConfig.workspaceDir);
  const channelSessions = await store.getAll();
  return c.json({ channelSessions });
});

app.use(
  "/ui/*",
  serveStatic({
    root: "./webui",
    rewriteRequestPath: (requestPath: string) => requestPath.replace(/^\/ui\//, "")
  })
);
app.get("/ui", serveStatic({ path: "./webui/index.html" }));
app.get("/", (c) => c.redirect("/ui"));

app.onError((error, c) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  return c.json({ error: message }, 500);
});

export { app, sessionStore, runStore, chatService };
