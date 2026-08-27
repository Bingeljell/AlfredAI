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
import { PinchtabPool } from "../tools/browser/pinchtabPool.js";
import { InMemoryQueue } from "../workers/inMemoryQueue.js";
import { ChatService, SessionMutex } from "../runner/chatService.js";
import { ChannelSessionStore } from "../channels/telegram/channelSessionStore.js";
import { GroupChatStore } from "../memory/groupChatStore.js";
import { AgentEventSchema } from "../agentEvents/schema.js";
import { authorizeAgentEvent } from "../agentEvents/auth.js";
import { AgentEventDispatcher } from "../agentEvents/dispatcher.js";
import {
  ConsoleAgentEventNotifier,
  TelegramAgentEventNotifier
} from "../agentEvents/notifier.js";
import type { AgentEventNotifier } from "../agentEvents/notifier.js";
import { AgentEventStore } from "../agentEvents/eventStore.js";
import type { ScheduledTaskV1 } from "../scheduler/types.js";
import type { WatchSnapshot } from "../scheduler/probes/types.js";
import { SchedulerTaskStore } from "../scheduler/taskStore.js";
import { SchedulerDeliveryStore } from "../scheduler/deliveryStore.js";
import { SchedulerTaskRunLog } from "../scheduler/taskRunLog.js";
import { SchedulerEngine } from "../scheduler/engine.js";
import type { SchedulerWakeExecutionResult } from "../scheduler/api.js";
import { ReminderExecutor } from "../scheduler/reminder.js";
import { WatchExecutor } from "../scheduler/watch.js";
import { RunStatusProbe } from "../scheduler/probes/runStatusProbe.js";
import { FileExistsProbe } from "../scheduler/probes/fileExistsProbe.js";
import { HerdrAgentProbe } from "../scheduler/probes/herdrAgentProbe.js";
import { DefaultHerdrReadOnlyClient } from "../scheduler/probes/defaultHerdrClient.js";
import {
  FileWebActivitySink,
  RoutingOutboundNotifier,
  TelegramOutboundNotifier,
  WebOutboundNotifier
} from "../scheduler/notifier.js";

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
const sessionMutex = new SessionMutex();

// ── Agent event webhook (docs/architecture/agent_event_webhook_spec.md) ──────
// Push notifications go to Telegram when both a bot token and an alert chat id
// are configured; otherwise events are logged to the console so they are never
// silently dropped.
const agentEventNotifier: AgentEventNotifier =
  appConfig.telegramBotToken && appConfig.telegramAlertChatId
    ? new TelegramAgentEventNotifier(appConfig.telegramBotToken, appConfig.telegramAlertChatId)
    : new ConsoleAgentEventNotifier();
const agentEventStore = new AgentEventStore(appConfig.workspaceDir);
const agentEventDispatcher = new AgentEventDispatcher({
  notifier: agentEventNotifier,
  store: agentEventStore
});

const schedulerTaskStore = new SchedulerTaskStore({ workspaceDir: appConfig.workspaceDir });
const schedulerDeliveryStore = new SchedulerDeliveryStore({ workspaceDir: appConfig.workspaceDir });
const schedulerNotifier = new RoutingOutboundNotifier(
  new WebOutboundNotifier(new FileWebActivitySink(appConfig.workspaceDir)),
  appConfig.telegramBotToken
    ? new TelegramOutboundNotifier(appConfig.telegramBotToken, {
        async isAllowed(destination) {
          const principalId = Number(destination.principalId);
          if (!Number.isSafeInteger(principalId) || !appConfig.telegramAllowedUserIds.includes(principalId)) return false;
          const channel = await new ChannelSessionStore(appConfig.workspaceDir).get(destination.channelKey);
          return Boolean(channel);
        }
      })
    : undefined
);
const schedulerTaskRunLog = new SchedulerTaskRunLog(appConfig.workspaceDir);
let scheduledWakeExecutor: ((task: ScheduledTaskV1, cycleId: string, snapshot?: WatchSnapshot, observationDigest?: string) => Promise<SchedulerWakeExecutionResult>) | undefined;
const schedulerHerdrProbe = new HerdrAgentProbe(new DefaultHerdrReadOnlyClient());
const schedulerWatchExecutor = new WatchExecutor({
  taskStore: schedulerTaskStore,
  deliveryStore: schedulerDeliveryStore,
  notifier: schedulerNotifier,
  probe: async (task, previousDigest) => {
    if (task.kind !== "watch" || !task.watch) throw new Error("invalid_watch_definition");
    switch (task.watch.type) {
      case "run_status": return new RunStatusProbe(runStore).probe(task.watch, previousDigest);
      case "file_exists": return new FileExistsProbe(appConfig.workspaceDir).probe(task.watch, previousDigest);
      case "herdr_agent": return schedulerHerdrProbe.probe(task.watch, previousDigest, task.id);
    }
  },
  executeWake: async (task, cycleId, snapshot, observationDigest) => {
    if (!scheduledWakeExecutor) throw new Error("scheduler_wake_executor_unavailable");
    return scheduledWakeExecutor(task, cycleId, snapshot, observationDigest);
  }
});
const schedulerEngine = new SchedulerEngine({
  taskStore: schedulerTaskStore,
  deliveryStore: schedulerDeliveryStore,
  taskRunLog: schedulerTaskRunLog,
  notifier: schedulerNotifier,
  reminderExecutor: new ReminderExecutor({
    taskStore: schedulerTaskStore,
    deliveryStore: schedulerDeliveryStore,
    notifier: schedulerNotifier
  }),
  watchExecutor: schedulerWatchExecutor,
  executeWake: async (task, cycleId, snapshot, observationDigest) => {
    if (!scheduledWakeExecutor) throw new Error("scheduler_wake_executor_unavailable");
    return scheduledWakeExecutor(task, cycleId, snapshot, observationDigest);
  },
  maxConcurrency: appConfig.schedulerMaxConcurrency,
  tickMaxMs: appConfig.schedulerTickMaxMs,
  globalWakeIntervalMs: appConfig.schedulerGlobalWakeIntervalMs,
  lookupRun: async (runId) => {
    const run = await runStore.getRun(runId);
    if (!run) return undefined;
    if (run.status === "needs_approval") return { status: "failed" };
    return { status: run.status === "queued" || run.status === "running" ? run.status : run.status };
  },
  requestRunCancellation: async (runId) => {
    await runStore.requestCancellation(runId);
  }
});
agentEventDispatcher.setSchedulerHook(schedulerEngine);

const chatService = new ChatService({
  sessionMutex,
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
  groupChatStore,
  taskTranscriptStore: schedulerTaskStore.transcriptStore,
  scheduler: appConfig.schedulerEnabled ? schedulerEngine : undefined
});

scheduledWakeExecutor = async (task, cycleId, snapshot, observationDigest) => {
  const outcome = await chatService.handleScheduledTurn({
    taskId: task.id,
    cycleId,
    sessionId: task.owner.sessionId,
    instruction: task.instruction ?? "Inspect the scheduled task and decide whether it is complete.",
    snapshot,
    observationDigest,
    owner: {
      principalId: task.owner.principalId,
      channelKey: task.owner.channelKey,
      origin: "scheduler"
    }
  });
  const updatedTask = await schedulerTaskStore.get(task.id) ?? task;
  return { ...updatedTask, assistantText: outcome.assistantText };
};

app.get("/health", (c) => {
  return c.json({
    ok: true,
    env: appConfig.env,
    timestamp: new Date().toISOString()
  });
});

app.get("/v1/providers/status", async (c) => {
  const status = await searchManager.getProviderStatus();
  const pinchtabConfigured = appConfig.enablePinchtab && Boolean(appConfig.pinchtabBaseUrl);
  const pinchtabHealthy = pinchtabConfigured
    ? await PinchtabPool.create(appConfig.pinchtabBaseUrl).health(750)
    : false;
  return c.json({
    ...status,
    browser: {
      preferred: pinchtabConfigured ? "pinchtab" : "playwright",
      pinchtabConfigured,
      pinchtabHealthy,
      playwrightFallbackEnabled: appConfig.enablePlaywright
    }
  });
});

app.get("/v1/llm/status", (c) => {
  return c.json({
    provider: appConfig.llmProvider,
    modelFast: appConfig.modelFast,
    modelSmart: appConfig.modelSmart,
    reasoning: appConfig.llmProvider === "openrouter"
      ? appConfig.openRouterReasoning ?? { mode: "model_default" }
      : null
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

  const response = await chatService.handleTurn({
    ...payload,
    principalId: "api",
    origin: "web",
    channelKey: `web:${payload.sessionId}`
  });
  return c.json(response);
});

app.get("/v1/scheduled-tasks", async (c) => {
  if (!appConfig.schedulerEnabled) return c.json({ error: "scheduler_disabled" }, 503);
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  const tasks = await schedulerEngine.list({ sessionId, principalId: "api", channelKey: `web:${sessionId}` }, c.req.query("includeTerminal") === "true");
  return c.json({ tasks });
});

app.post("/v1/scheduled-tasks/:taskId/cancel", async (c) => {
  if (!appConfig.schedulerEnabled) return c.json({ error: "scheduler_disabled" }, 503);
  try {
    const task = await schedulerEngine.cancel(c.req.param("taskId"), {
      sessionId: c.req.query("sessionId") ?? "",
      principalId: "api",
      channelKey: c.req.query("channelKey")
    });
    return c.json({ task });
  } catch {
    return c.json({ error: "scheduled_task_not_found" }, 404);
  }
});

app.get("/v1/scheduler/status", async (c) => {
  if (!appConfig.schedulerEnabled) return c.json({ enabled: false, running: false });
  return c.json(await schedulerEngine.statusWithTasks());
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

// ── Agent event webhook ─ POST /api/events/agent ─────────────────────────────
// Decoupled ingress for external agents / terminal wrappers (Herdr, tmux/Zellij
// hooks, standalone agent hooks). Auth: shared X-Agent-Event-Token secret, or
// loopback-only when no token is configured. Zod errors fall through to
// app.onError which maps them to 400 with issue details.
app.post("/api/events/agent", async (c) => {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } };
  const authorized = authorizeAgentEvent({
    remoteAddress: env?.incoming?.socket?.remoteAddress,
    providedToken: c.req.header("X-Agent-Event-Token"),
    configuredToken: appConfig.agentEventToken
  });
  if (!authorized) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json(
      { error: "Invalid request", details: [{ path: [], message: "Body must be valid JSON" }] },
      400
    );
  }

  const event = AgentEventSchema.parse(json);
  const result = await agentEventDispatcher.dispatch(event);
  return c.json({ ok: true, ...result });
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

export { app, sessionStore, runStore, chatService, searchManager, agentEventDispatcher, agentEventStore, schedulerEngine };
