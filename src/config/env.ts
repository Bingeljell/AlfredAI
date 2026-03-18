import { config as loadDotEnv } from "dotenv";
import path from "node:path";
import { z } from "zod";
import type { PolicyMode } from "../types.js";

loadDotEnv();

const EnvSchema = z.object({
  ALFRED_ENV: z.enum(["dev", "prod"]).default("dev"),
  PORT: z.coerce.number().default(3000),
  // ─── LLM provider ─────────────────────────────────────────────────────────
  ALFRED_LLM_PROVIDER: z.enum(["openai", "anthropic", "gemini", "ollama"]).default("openai"),
  ALFRED_MODEL_FAST: z.string().default("gpt-4o-mini"),   // cheap/fast: classification, session extractor
  ALFRED_MODEL_SMART: z.string().default("gpt-4o"),       // specialist agent loops
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_GEMINI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  SEARXNG_BASE_URL: z.string().url().default("http://127.0.0.1:8888"),
  SEARXNG_SEARCH_PATH: z.string().default("/search"),
  SEARXNG_HEALTH_PATH: z.string().default("/search?q=ping&format=json"),
  SEARXNG_START_CMD: z.string().default(""),
  SEARXNG_START_TIMEOUT_MS: z.coerce.number().default(15000),
  SEARXNG_RETRY_INTERVAL_MS: z.coerce.number().default(1000),
  SEARXNG_HEALTH_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  SEARXNG_HEALTH_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(250),
  SEARXNG_HEALTH_GRACE_MS: z.coerce.number().int().min(0).max(120000).default(15000),
  BRIGHTDATA_SEARCH_API_KEY: z.string().default(""),
  BRIGHTDATA_SEARCH_BASE_URL: z.string().url().default("https://api.brightdata.com"),
  BRIGHTDATA_SEARCH_PATH: z.string().default("/request"),
  BRIGHTDATA_SEARCH_ZONE: z.string().default(""),
  BRIGHTDATA_SEARCH_ENGINE: z.string().default("duckduckgo"),
  BRIGHTDATA_SEARCH_COUNTRY: z.string().default("us"),
  BRIGHTDATA_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(12000),
  BRAVE_SEARCH_API_KEY: z.string().default(""),
  ALFRED_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(15).default(15),
  ALFRED_FAST_SCRAPE_COUNT: z.coerce.number().int().min(1).max(10).default(10),
  ALFRED_ENABLE_PLAYWRIGHT: z.string().default("true"),
  ALFRED_ENABLE_PINCHTAB: z.string().default("false"),
  PINCHTAB_BASE_URL: z.string().default("http://127.0.0.1:9867"),
  ALFRED_RUN_MAX_STEPS: z.coerce.number().int().min(1).max(12).default(6),
  ALFRED_WORKSPACE_DIR: z.string().default("./workspace/alfred"),
  ALFRED_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  ALFRED_SUBREACT_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(10),
  ALFRED_SUBREACT_BROWSE_CONCURRENCY: z.coerce.number().int().min(1).max(6).default(3),
  ALFRED_SUBREACT_BATCH_SIZE: z.coerce.number().int().min(1).max(6).default(4),
  ALFRED_SUBREACT_LLM_MAX_CALLS: z.coerce.number().int().min(1).max(20).default(6),
  ALFRED_SUBREACT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  ALFRED_AGENT_MAX_DURATION_MS: z.coerce.number().int().min(60000).max(900000).default(600000),
  ALFRED_AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(3).max(60).default(18),
  ALFRED_AGENT_MAX_PARALLEL_TOOLS: z.coerce.number().int().min(1).max(5).default(3),
  ALFRED_AGENT_PLANNER_MAX_CALLS: z.coerce.number().int().min(1).max(30).default(10),
  ALFRED_AGENT_OBSERVATION_WINDOW: z.coerce.number().int().min(3).max(20).default(8),
  ALFRED_AGENT_DIMINISHING_THRESHOLD: z.coerce.number().int().min(1).max(10).default(2),
  // ─── Channels ─────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // Comma-separated Telegram user IDs allowed to interact with the bot
  TELEGRAM_ALLOWED_USER_IDS: z.string().default("")
});

const parsed = EnvSchema.parse(process.env);

export const appConfig = {
  env: parsed.ALFRED_ENV,
  port: parsed.PORT,
  llmProvider: parsed.ALFRED_LLM_PROVIDER,
  modelFast: parsed.ALFRED_MODEL_FAST,
  modelSmart: parsed.ALFRED_MODEL_SMART,
  openAiApiKey: parsed.OPENAI_API_KEY,
  anthropicApiKey: parsed.ANTHROPIC_API_KEY,
  geminiApiKey: parsed.GOOGLE_GEMINI_API_KEY,
  ollamaBaseUrl: parsed.OLLAMA_BASE_URL,
  searxngBaseUrl: parsed.SEARXNG_BASE_URL,
  searxngSearchPath: parsed.SEARXNG_SEARCH_PATH,
  searxngHealthPath: parsed.SEARXNG_HEALTH_PATH,
  searxngStartCommand: parsed.SEARXNG_START_CMD,
  searxngStartTimeoutMs: parsed.SEARXNG_START_TIMEOUT_MS,
  searxngRetryIntervalMs: parsed.SEARXNG_RETRY_INTERVAL_MS,
  searxngHealthRetries: parsed.SEARXNG_HEALTH_RETRIES,
  searxngHealthRetryDelayMs: parsed.SEARXNG_HEALTH_RETRY_DELAY_MS,
  searxngHealthGraceMs: parsed.SEARXNG_HEALTH_GRACE_MS,
  brightDataSearchApiKey: parsed.BRIGHTDATA_SEARCH_API_KEY,
  brightDataSearchBaseUrl: parsed.BRIGHTDATA_SEARCH_BASE_URL,
  brightDataSearchPath: parsed.BRIGHTDATA_SEARCH_PATH,
  brightDataSearchZone: parsed.BRIGHTDATA_SEARCH_ZONE,
  brightDataSearchEngine: parsed.BRIGHTDATA_SEARCH_ENGINE,
  brightDataSearchCountry: parsed.BRIGHTDATA_SEARCH_COUNTRY,
  brightDataSearchTimeoutMs: parsed.BRIGHTDATA_SEARCH_TIMEOUT_MS,
  braveSearchApiKey: parsed.BRAVE_SEARCH_API_KEY,
  searchMaxResults: parsed.ALFRED_SEARCH_MAX_RESULTS,
  fastScrapeCount: parsed.ALFRED_FAST_SCRAPE_COUNT,
  enablePlaywright: parsed.ALFRED_ENABLE_PLAYWRIGHT.toLowerCase() === "true",
  enablePinchtab: parsed.ALFRED_ENABLE_PINCHTAB.toLowerCase() === "true",
  pinchtabBaseUrl: parsed.PINCHTAB_BASE_URL,
  runMaxSteps: parsed.ALFRED_RUN_MAX_STEPS,
  workspaceDir: path.resolve(parsed.ALFRED_WORKSPACE_DIR),
  concurrency: parsed.ALFRED_CONCURRENCY,
  subReactMaxPages: parsed.ALFRED_SUBREACT_MAX_PAGES,
  subReactBrowseConcurrency: parsed.ALFRED_SUBREACT_BROWSE_CONCURRENCY,
  subReactBatchSize: parsed.ALFRED_SUBREACT_BATCH_SIZE,
  subReactLlmMaxCalls: parsed.ALFRED_SUBREACT_LLM_MAX_CALLS,
  subReactMinConfidence: parsed.ALFRED_SUBREACT_MIN_CONFIDENCE,
  agentMaxDurationMs: parsed.ALFRED_AGENT_MAX_DURATION_MS,
  agentMaxToolCalls: parsed.ALFRED_AGENT_MAX_TOOL_CALLS,
  agentMaxParallelTools: parsed.ALFRED_AGENT_MAX_PARALLEL_TOOLS,
  agentPlannerMaxCalls: parsed.ALFRED_AGENT_PLANNER_MAX_CALLS,
  agentObservationWindow: parsed.ALFRED_AGENT_OBSERVATION_WINDOW,
  agentDiminishingThreshold: parsed.ALFRED_AGENT_DIMINISHING_THRESHOLD,
  telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
  telegramAllowedUserIds: parsed.TELEGRAM_ALLOWED_USER_IDS
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n))
};

export function getPolicyMode(): PolicyMode {
  return appConfig.env === "dev" ? "trusted" : "balanced";
}
