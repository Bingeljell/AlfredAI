import { OpenAiLlmProvider } from "./openai.js";

// Ollama exposes an OpenAI-compatible API at {baseUrl}/v1/chat/completions.
// No translation needed — just point the OpenAI provider at the local endpoint.

interface OllamaLlmProviderOptions {
  baseUrl: string;
  defaultModel?: string;
}

export class OllamaLlmProvider extends OpenAiLlmProvider {
  constructor(options: OllamaLlmProviderOptions) {
    super({
      name: "ollama",
      apiKey: "ollama", // Ollama ignores the key but the client requires a non-empty string
      defaultModel: options.defaultModel ?? "llama3.2",
      baseUrl: options.baseUrl
    });
  }
}
