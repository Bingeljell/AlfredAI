import { createHash } from "node:crypto";
import type { LlmConversationMessage, LlmProviderState, LlmToolDef } from "../types.js";
import type {
  CodexJsonObject,
  CodexMessageTranslation,
  CodexRequestBody,
  CodexResponsesOutputItem
} from "./types.js";

function outputItemsFromState(state: LlmProviderState | undefined): CodexResponsesOutputItem[] | undefined {
  if (!state || state.provider !== "codex" || !state.data || typeof state.data !== "object") return undefined;
  const data = state.data as Record<string, unknown>;
  return Array.isArray(data.outputItems) ? data.outputItems as CodexResponsesOutputItem[] : undefined;
}

/** Convert Alfred conversation messages into Responses input items. */
export function toResponsesInput(messages: LlmConversationMessage[]): CodexMessageTranslation {
  const systemMessages: string[] = [];
  const input: CodexResponsesOutputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemMessages.push(message.content);
      continue;
    }

    if (message.role === "user") {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: message.content }]
      });
      continue;
    }

    if (message.role === "assistant") {
      const replayItems = outputItemsFromState(message.providerState);
      if (replayItems?.length) {
        for (const item of replayItems) {
          input.push(item);
        }
        continue;
      }

      if (message.content) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text: message.content }]
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments
        });
      }
      continue;
    }

    input.push({
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content
    });
  }

  return {
    instructions: systemMessages.length ? systemMessages.join("\n\n") : undefined,
    input
  };
}

export function toResponsesTools(tools: LlmToolDef[]): CodexJsonObject[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: null
  }));
}

export function buildStablePromptCacheKey(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `alfred-${digest}`.slice(0, 64);
}

export function buildCodexRequestBody(args: {
  model: string;
  messages: LlmConversationMessage[];
  tools?: LlmToolDef[];
  sessionId?: string;
  text?: CodexJsonObject;
}): CodexRequestBody {
  const translation = toResponsesInput(args.messages);
  const body: CodexRequestBody = {
    model: args.model,
    store: false,
    stream: true,
    input: translation.input,
    text: { verbosity: "low", ...(args.text ?? {}) },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true
  };

  if (translation.instructions) body.instructions = translation.instructions;
  const promptCacheKey = buildStablePromptCacheKey(args.sessionId);
  if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
  if (args.tools?.length) body.tools = toResponsesTools(args.tools);
  return body;
}

export const translateCodexMessages = toResponsesInput;
export const translateCodexTools = toResponsesTools;
