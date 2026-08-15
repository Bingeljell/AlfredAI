import { OpenAiLlmProvider } from "./openai.js";

// OpenRouter serves an OpenAI-compatible API at {baseUrl}/v1/chat/completions
// (default https://openrouter.ai/api/v1). No translation needed — just point the
// OpenAI provider at OpenRouter's endpoint. Tool calling works for any model with
// function calling; strict json_schema structured output is model-dependent
// (the lead_extractor path degrades to regex extraction if the model rejects it).

interface OpenRouterLlmProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class OpenRouterLlmProvider extends OpenAiLlmProvider {
  constructor(options: OpenRouterLlmProviderOptions) {
    super({
      name: "openrouter",
      apiKey: options.apiKey,
      defaultModel: options.defaultModel ?? "openai/gpt-4o",
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1"
    });
  }
}
