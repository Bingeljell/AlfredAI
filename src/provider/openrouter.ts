import { OpenAiLlmProvider } from "./openai.js";
import type { LlmReasoningConfig } from "./types.js";

// OpenRouter serves an OpenAI-compatible API at
// https://openrouter.ai/api/v1/chat/completions. This client appends
// "/v1/chat/completions" to baseUrl itself, so the base must be the origin
// plus "/api" — NOT the documented ".../api/v1" form (which would double the
// /v1 and 404). normalizeBaseUrl also strips a trailing /v1 defensively, so
// either form works.

interface OpenRouterLlmProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  reasoning?: LlmReasoningConfig;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  // ".../api/v1" (OpenRouter's documented base) -> ".../api";
  // origin-based form is unchanged. Client then appends /v1/chat/completions.
  return trimmed.endsWith("/api/v1") ? trimmed.slice(0, -3) : trimmed;
}

export class OpenRouterLlmProvider extends OpenAiLlmProvider {
  constructor(options: OpenRouterLlmProviderOptions) {
    super({
      name: "openrouter",
      apiKey: options.apiKey,
      defaultModel: options.defaultModel ?? "openai/gpt-4o",
      baseUrl: normalizeBaseUrl(options.baseUrl ?? "https://openrouter.ai/api"),
      defaultReasoning: options.reasoning,
      forwardSessionId: true,
      requireReasoningSupport: true,
      extraHeaders: {
        "X-OpenRouter-Metadata": "enabled"
      }
    });
  }
}
