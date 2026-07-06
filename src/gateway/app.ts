import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { appConfig } from "../config/env.js";
import { SessionStore } from "../memory/sessionStore.js";
import { RunStore } from "../runs/runStore.js";
import { SearxngProvider } from "../tools/search/providers/searxngProvider.js";
import { BraveProvider } from "../tools/search/providers/braveProvider.js";
import { BrightDataProvider } from "../tools/search/providers/brightDataProvider.js";
import { SearchManager } from "../tools/search/searchManager.js";
import { InMemoryQueue } from "../workers/inMemoryQueue.js";
import { ChatService } from "../runner/chatService.js";
import { ChannelSessionStore } from "../channels/telegram/channelSessionStore.js";
import { GroupChatStore } from "../memory/groupChatStore.js";

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

// ── Rate limiting — fixed window per client IP over /v1/* ─────────────────────
// Bounds credential brute-forcing and general abuse. Sized generously so the
// polling web UI (a few requests/second at most) is never affected.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimitExceeded(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    if (rateBuckets.size > 5_000) {
      for (const [key, value] of rateBuckets) {
        if (now >= value.resetAt) {
          rateBuckets.delete(key);
        }
      }
    }
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

// Constant-time comparison so the key check does not leak length/prefix via timing.
function safeKeyEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

// ── API key auth — all /v1/* routes ──────────────────────────────────────────
// Key is resolved at startup by server.ts (auto-generated if not in .env).
// We read it lazily from process.env so the middleware always sees the final value.
app.use("/v1/*", async (c, next) => {
  const fwd = c.req.header("x-forwarded-for");
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } };
  const ip = (fwd ? fwd.split(",")[0]?.trim() : undefined) || env?.incoming?.socket?.remoteAddress || "unknown";
  if (rateLimitExceeded(ip)) {
    return c.json({ error: "Too many requests" }, 429);
  }

  const key = process.env.ALFRED_API_KEY;
  if (!key) {
    await next();
    return;
  }
  const header =
    c.req.header("X-Api-Key") ??
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!header || !safeKeyEqual(header, key)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

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

const groupChatStore = new GroupChatStore(appConfig.workspaceDir);

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
  browseConcurrency: appConfig.browseConcurrency,
  pinchtabBaseUrl: appConfig.enablePinchtab ? appConfig.pinchtabBaseUrl : undefined,
  agentMaxDurationMs: appConfig.agentMaxDurationMs,
  agentMaxToolCalls: appConfig.agentMaxToolCalls,
  agentMaxParallelTools: appConfig.agentMaxParallelTools,
  groupChatStore
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

app.get("/v1/llm/status", (c) => {
  return c.json({
    provider: appConfig.llmProvider,
    modelFast: appConfig.modelFast,
    modelSmart: appConfig.modelSmart
  });
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
  if (error instanceof z.ZodError) {
    return c.json(
      { error: "Invalid request", details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
      400
    );
  }
  console.error("[gateway] unhandled error:", error);
  return c.json({ error: "Internal server error" }, 500);
});

export { app, sessionStore, runStore, chatService, searchManager };
