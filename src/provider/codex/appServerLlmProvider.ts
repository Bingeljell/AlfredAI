import type { z } from "zod";
import type { LlmProvider, LlmStructuredRequest, LlmStructuredResult, LlmTextRequest, LlmTextResult, LlmToolCallRequest, LlmToolCallResult } from "../types.js";
import type { AppServerClientFactory } from "./appServerTurn.js";
import { runSafeAppServerTurn } from "./appServerTurn.js";

function prompt(request: { messages: Array<{ role: string; content: string | null }> }): { system: string; input: string } {
  return {
    system: request.messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n\n"),
    input: request.messages.filter((message) => message.role !== "system").map((message) => `${message.role}: ${message.content ?? ""}`).join("\n\n")
  };
}

function parseJson(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(clean) as unknown; } catch { return undefined; }
}

export class CodexAppServerLlmProvider implements LlmProvider {
  readonly name = "codex-app-server";

  constructor(private readonly options: { defaultModel: string; clientFactory?: AppServerClientFactory }) {}

  async generateText(request: LlmTextRequest): Promise<LlmTextResult> {
    const parts = prompt(request);
    const result = await runSafeAppServerTurn({
      model: request.model ?? this.options.defaultModel,
      baseInstructions: parts.system || "Produce only the requested text.",
      input: parts.input,
      timeoutMs: request.timeoutMs ?? 45_000,
      signal: request.signal,
      clientFactory: this.options.clientFactory
    });
    if (result.status !== "completed") return { provider: this.name, failureCode: result.status === "timeout" ? "timeout" : result.status === "interrupted" ? "cancelled" : "codex_app_server_error", failureMessage: result.error, elapsedMs: result.elapsedMs };
    return { provider: this.name, content: result.content, usage: result.usage, elapsedMs: result.elapsedMs };
  }

  async generateStructured<T>(request: LlmStructuredRequest, validator: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
    const parts = prompt(request);
    const result = await runSafeAppServerTurn({
      model: request.model ?? this.options.defaultModel,
      baseInstructions: parts.system || "Return a JSON object matching the requested schema.",
      input: parts.input,
      outputSchema: request.jsonSchema,
      timeoutMs: request.timeoutMs ?? 45_000,
      signal: request.signal,
      clientFactory: this.options.clientFactory
    });
    if (result.status !== "completed") return { provider: this.name, failureCode: result.status === "timeout" ? "timeout" : result.status === "interrupted" ? "cancelled" : "codex_app_server_error", failureMessage: result.error, elapsedMs: result.elapsedMs };
    const checked = validator.safeParse(parseJson(result.content));
    if (!checked.success) return { provider: this.name, failureCode: "schema_validation", failureMessage: "Codex App Server returned an invalid structured response.", usage: result.usage, elapsedMs: result.elapsedMs };
    return { provider: this.name, result: checked.data, usage: result.usage, elapsedMs: result.elapsedMs };
  }

  async generateWithTools(_request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    return { provider: this.name, failureCode: "unsupported", failureMessage: "Nested tool turns are owned by Alfred's outer dynamic-tool bridge." };
  }
}
