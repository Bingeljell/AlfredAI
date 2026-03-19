import { appConfig } from "../config/env.js";
import { AnthropicLlmProvider } from "./anthropic.js";
import { GeminiLlmProvider } from "./gemini.js";
import { OllamaLlmProvider } from "./ollama.js";
import { OpenAiLlmProvider } from "./openai.js";
import type { LlmProvider } from "./types.js";

let _provider: LlmProvider | null = null;

/**
 * Returns the active LlmProvider singleton, configured from env vars.
 *
 * ALFRED_LLM_PROVIDER controls which provider is used.
 * ALFRED_MODEL_SMART is the default model for specialist loops.
 * ALFRED_MODEL_FAST is the default model for cheap/fast calls (classification, extraction).
 *
 * API keys: OPENAI_API_KEY | ANTHROPIC_API_KEY | GOOGLE_GEMINI_API_KEY | OLLAMA_BASE_URL
 */
export function getActiveLlmProvider(): LlmProvider {
  if (_provider) return _provider;

  switch (appConfig.llmProvider) {
    case "anthropic": {
      if (!appConfig.anthropicApiKey) {
        throw new Error("ANTHROPIC_API_KEY is required when ALFRED_LLM_PROVIDER=anthropic");
      }
      _provider = new AnthropicLlmProvider({
        apiKey: appConfig.anthropicApiKey,
        defaultModel: appConfig.modelSmart
      });
      break;
    }

    case "gemini": {
      if (!appConfig.geminiApiKey) {
        throw new Error("GOOGLE_GEMINI_API_KEY is required when ALFRED_LLM_PROVIDER=gemini");
      }
      _provider = new GeminiLlmProvider({
        apiKey: appConfig.geminiApiKey,
        defaultModel: appConfig.modelSmart
      });
      break;
    }

    case "ollama": {
      _provider = new OllamaLlmProvider({
        baseUrl: appConfig.ollamaBaseUrl,
        defaultModel: appConfig.modelSmart
      });
      break;
    }

    default: {
      // "openai" or any unrecognised value
      _provider = new OpenAiLlmProvider({
        apiKey: appConfig.openAiApiKey ?? "",
        defaultModel: appConfig.modelSmart
      });
    }
  }

  return _provider;
}

/** Exposed for tests that need to inject a mock provider. */
export function setActiveLlmProvider(provider: LlmProvider): void {
  _provider = provider;
}

/** Reset the singleton (used in tests). */
export function resetActiveLlmProvider(): void {
  _provider = null;
}
