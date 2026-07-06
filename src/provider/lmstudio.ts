import { OpenAiLlmProvider } from "./openai.js";

// LM Studio serves an OpenAI-compatible API at {baseUrl}/v1/chat/completions
// (default http://localhost:1234). No translation needed — just point the
// OpenAI provider at the local endpoint. Tool calling and json_schema structured
// output work as long as the loaded model ships a tool-capable chat template.

interface LmStudioLlmProviderOptions {
  baseUrl: string;
  defaultModel?: string;
}

export class LmStudioLlmProvider extends OpenAiLlmProvider {
  constructor(options: LmStudioLlmProviderOptions) {
    super({
      name: "lmstudio",
      apiKey: "lm-studio", // LM Studio ignores the key but the client requires a non-empty string
      defaultModel: options.defaultModel ?? "local-model",
      baseUrl: options.baseUrl
    });
  }
}
