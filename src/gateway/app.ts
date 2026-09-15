import { Hono } from "hono";
import { conversationStream } from "./conversationStream.js";
import type { Context } from "hono";
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
import { ChannelSessionStore } from "../channels/channelSessionStore.js";
import { IdentityStore } from "../channels/identityStore.js";
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
import { CodexAccountService } from "../provider/codex/accountService.js";
import { CodexSubscriptionService } from "../provider/codex/subscriptionService.js";
import { CodexAppServerRuntime } from "../runtime/codexAppServerRuntime.js";

const SessionPostSchema = z.object({
  action: z.enum(["create", "list"]).default("list"),
  name: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const ChatTurnSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  surface: z.enum(["web", "tui"]).default("web"),
  requestId: z.string().uuid().optional(),
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
let codexAccountService = new CodexAccountService();
let codexSubscriptionService = new CodexSubscriptionService(codexAccountService.appServerClient, () => codexAccountService.initialize());

type AccountResponseStatus = 200 | 404 | 503;

function accountJson(c: Context, body: unknown, status: AccountResponseStatus = 200) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json(body, status);
}

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

const identities = new IdentityStore(appConfig.workspaceDir);
const schedulerTaskStore = new SchedulerTaskStore({ workspaceDir: appConfig.workspaceDir, principalAliases: (id) => identities.aliases(id) });
const schedulerDeliveryStore = new SchedulerDeliveryStore({ workspaceDir: appConfig.workspaceDir });
const webActivity = new FileWebActivitySink(appConfig.workspaceDir);
const schedulerNotifier = new RoutingOutboundNotifier(
  new WebOutboundNotifier(webActivity),
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

const agentRuntime = appConfig.llmProvider === "codex"
  ? new CodexAppServerRuntime({
      runStore, searchManager, workspaceDir: appConfig.workspaceDir, searchMaxResults: appConfig.searchMaxResults,
      fastScrapeCount: appConfig.fastScrapeCount, enablePlaywright: appConfig.enablePlaywright, maxSteps: appConfig.runMaxSteps,
      openAiApiKey: appConfig.openAiApiKey, browseConcurrency: appConfig.browseConcurrency,
      pinchtabBaseUrl: appConfig.enablePinchtab ? appConfig.pinchtabBaseUrl : undefined,
      agentMaxDurationMs: appConfig.agentMaxDurationMs, agentMaxToolCalls: appConfig.agentMaxToolCalls,
      agentMaxParallelTools: appConfig.agentMaxParallelTools, scheduler: appConfig.schedulerEnabled ? schedulerEngine : undefined,
      subscriptionService: codexSubscriptionService, defaultModel: appConfig.modelSmart
    })
  : undefined;

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
  scheduler: appConfig.schedulerEnabled ? schedulerEngine : undefined,
  agentRuntime,
  subscriptionService: appConfig.llmProvider === "codex" ? codexSubscriptionService : undefined,
  globalModel: appConfig.modelSmart
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

app.get("/v1/accounts/openai", async (c) => {
  try {
    return accountJson(c, { account: await codexAccountService.readAccount() });
  } catch {
    return accountJson(c, { error: "openai_account_unavailable" }, 503);
  }
});

app.post("/v1/accounts/openai/login", async (c) => {
  const payload = z.object({ mode: z.enum(["browser", "device-code"]).default("browser") }).parse(await c.req.json().catch(() => ({})));
  try {
    return accountJson(c, await codexAccountService.startLogin(payload.mode));
  } catch {
    return accountJson(c, { error: "openai_login_unavailable" }, 503);
  }
});

app.post("/v1/accounts/openai/login/device", async (c) => {
  try {
    return accountJson(c, await codexAccountService.startLogin("device-code"));
  } catch {
    return accountJson(c, { error: "openai_login_unavailable" }, 503);
  }
});

app.get("/v1/accounts/openai/login/:loginId", (c) => {
  const login = codexAccountService.getLogin(c.req.param("loginId"));
  return login ? accountJson(c, login) : accountJson(c, { error: "openai_login_not_found" }, 404);
});

app.delete("/v1/accounts/openai/login/:loginId", async (c) => {
  try {
    return accountJson(c, await codexAccountService.cancelLogin(c.req.param("loginId")));
  } catch {
    return accountJson(c, { error: "openai_login_cancel_failed" }, 503);
  }
});

app.post("/v1/accounts/openai/logout", async (c) => {
  try {
    await codexAccountService.logout();
    return accountJson(c, { ok: true });
  } catch {
    return accountJson(c, { error: "openai_logout_failed" }, 503);
  }
});

app.get("/v1/accounts/openai/models", async (c) => {
  try {
    return accountJson(c, await codexSubscriptionService.readCatalog());
  } catch {
    return accountJson(c, { error: "openai_model_catalog_unavailable" }, 503);
  }
});

app.get("/v1/accounts/openai/usage", async (c) => {
  try {
    return accountJson(c, await codexSubscriptionService.readUsage());
  } catch {
    return accountJson(c, { error: "openai_usage_unavailable" }, 503);
  }
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
    origin: payload.surface,
    channelKey: `${payload.surface}:${payload.sessionId}`
  });
  return c.json(response);
});

app.get("/v1/sessions/:sessionId/stream", (c) => conversationStream(c, sessionStore, runStore, webActivity));

app.get("/v1/sessions/:sessionId/history", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!await sessionStore.getSession(sessionId)) return c.json({ error: "Session not found" }, 404);
  const limit = z.coerce.number().int().min(1).max(100).parse(c.req.query("limit") ?? 50);
  return c.json(await runStore.listHistory(sessionId, { limit, before: c.req.query("before") }));
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

app.post("/v1/channels/attach", async (c) => {
  const payload = z.object({ channelKey: z.string().regex(/^(telegram:-?\d+|(?:web|tui):[a-zA-Z0-9_-]+)$/), sessionId: z.string().uuid() }).strict().parse(await c.req.json());
  if (!await sessionStore.getSession(payload.sessionId)) return c.json({ error: "Session not found" }, 404);
  const store = new ChannelSessionStore(appConfig.workspaceDir);
  const existing = await store.get(payload.channelKey);
  // Telegram bindings must have been observed by the authorized adapter first.
  if (payload.channelKey.startsWith("telegram:") && !existing) return c.json({ error: "Unknown Telegram channel" }, 404);
  await store.set(payload.channelKey, { sessionId: payload.sessionId, label: existing?.label ?? null, createdAt: new Date().toISOString() });
  return c.json({ channelKey: payload.channelKey, sessionId: payload.sessionId });
});

app.post("/v1/identities/link-telegram", async (c) => {
  const { userId } = z.object({ userId: z.string().regex(/^\d+$/) }).strict().parse(await c.req.json());
  if (!appConfig.telegramAllowedUserIds.includes(Number(userId))) return c.json({ error: "Telegram user is not allowlisted" }, 403);
  await identities.linkTelegram(userId);
  return c.json({ linked: true, principalIds: await identities.aliases("api") });
});

app.delete("/v1/identities/telegram/:userId", async (c) => {
  await identities.unlinkTelegram(z.string().regex(/^\d+$/).parse(c.req.param("userId")));
  return c.json({ unlinked: true });
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
  if (error.message === "request_id_conflict") return c.json({ error: "request_id_conflict" }, 409);
  if (error instanceof z.ZodError) {
    return c.json(
      { error: "Invalid request", details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
      400
    );
  }
  console.error("[gateway] unhandled error:", error);
  return c.json({ error: "Internal server error" }, 500);
});

export function setCodexAccountServiceForTests(service: CodexAccountService): void {
  codexAccountService = service;
  if (codexAccountService.appServerClient) {
    codexSubscriptionService = new CodexSubscriptionService(codexAccountService.appServerClient, () => codexAccountService.initialize());
  }
}

export { app, sessionStore, runStore, chatService, searchManager, agentEventDispatcher, agentEventStore, schedulerEngine, codexAccountService, codexSubscriptionService };
