import { config as loadDotEnv } from "dotenv";
import path from "node:path";
import { z } from "zod";
import type { PolicyMode } from "../types.js";

loadDotEnv();

const EnvSchema = z.object({
  ALFRED_ENV: z.enum(["dev", "prod"]).default("dev"),
  PORT: z.coerce.number().default(3000),
  OPENAI_API_KEY: z.string().optional(),
  SEARXNG_BASE_URL: z.string().url().default("http://127.0.0.1:8888"),
  SEARXNG_SEARCH_PATH: z.string().default("/search"),
  SEARXNG_HEALTH_PATH: z.string().default("/search?q=ping&format=json"),
  SEARXNG_START_CMD: z.string().default(""),
  SEARXNG_START_TIMEOUT_MS: z.coerce.number().default(15000),
  SEARXNG_RETRY_INTERVAL_MS: z.coerce.number().default(1000),
  BRAVE_SEARCH_API_KEY: z.string().default(""),
  ALFRED_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(15).default(15),
  ALFRED_FAST_SCRAPE_COUNT: z.coerce.number().int().min(1).max(10).default(10),
  ALFRED_ENABLE_PLAYWRIGHT: z.string().default("true"),
  ALFRED_RUN_MAX_STEPS: z.coerce.number().int().min(1).max(12).default(6),
  ALFRED_WORKSPACE_DIR: z.string().default("./workspace/alfred"),
  ALFRED_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  ALFRED_SUBREACT_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(10),
  ALFRED_SUBREACT_BROWSE_CONCURRENCY: z.coerce.number().int().min(1).max(6).default(3),
  ALFRED_SUBREACT_BATCH_SIZE: z.coerce.number().int().min(1).max(6).default(4),
  ALFRED_SUBREACT_LLM_MAX_CALLS: z.coerce.number().int().min(1).max(20).default(6),
  ALFRED_SUBREACT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6)
});

const parsed = EnvSchema.parse(process.env);

export const appConfig = {
  env: parsed.ALFRED_ENV,
  port: parsed.PORT,
  openAiApiKey: parsed.OPENAI_API_KEY,
  searxngBaseUrl: parsed.SEARXNG_BASE_URL,
  searxngSearchPath: parsed.SEARXNG_SEARCH_PATH,
  searxngHealthPath: parsed.SEARXNG_HEALTH_PATH,
  searxngStartCommand: parsed.SEARXNG_START_CMD,
  searxngStartTimeoutMs: parsed.SEARXNG_START_TIMEOUT_MS,
  searxngRetryIntervalMs: parsed.SEARXNG_RETRY_INTERVAL_MS,
  braveSearchApiKey: parsed.BRAVE_SEARCH_API_KEY,
  searchMaxResults: parsed.ALFRED_SEARCH_MAX_RESULTS,
  fastScrapeCount: parsed.ALFRED_FAST_SCRAPE_COUNT,
  enablePlaywright: parsed.ALFRED_ENABLE_PLAYWRIGHT.toLowerCase() === "true",
  runMaxSteps: parsed.ALFRED_RUN_MAX_STEPS,
  workspaceDir: path.resolve(parsed.ALFRED_WORKSPACE_DIR),
  concurrency: parsed.ALFRED_CONCURRENCY,
  subReactMaxPages: parsed.ALFRED_SUBREACT_MAX_PAGES,
  subReactBrowseConcurrency: parsed.ALFRED_SUBREACT_BROWSE_CONCURRENCY,
  subReactBatchSize: parsed.ALFRED_SUBREACT_BATCH_SIZE,
  subReactLlmMaxCalls: parsed.ALFRED_SUBREACT_LLM_MAX_CALLS,
  subReactMinConfidence: parsed.ALFRED_SUBREACT_MIN_CONFIDENCE
};

export function getPolicyMode(): PolicyMode {
  return appConfig.env === "dev" ? "trusted" : "balanced";
}
