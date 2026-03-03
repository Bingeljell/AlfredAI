import { z } from "zod";

interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiChatOptions {
  apiKey?: string;
  model?: string;
  messages: OpenAiMessage[];
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface OpenAiStructuredChatOptions extends OpenAiChatOptions {
  schemaName: string;
  jsonSchema: Record<string, unknown>;
}

async function parseResponse(response: Response): Promise<string | undefined> {
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json()) as OpenAiResponse;
  return payload.choices?.[0]?.message?.content?.trim() || undefined;
}

export async function runOpenAiChat(options: OpenAiChatOptions): Promise<string | undefined> {
  if (!options.apiKey) {
    return undefined;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.model ?? "gpt-4.1-mini",
      temperature: 0.2,
      messages: options.messages
    }),
    signal: AbortSignal.timeout(25000)
  });

  return parseResponse(response);
}

export async function runOpenAiStructuredChat<T>(
  options: OpenAiStructuredChatOptions,
  validator: z.ZodType<T>
): Promise<T | undefined> {
  if (!options.apiKey) {
    return undefined;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.model ?? "gpt-4.1-mini",
      temperature: 0,
      messages: options.messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: options.schemaName,
          schema: options.jsonSchema,
          strict: true
        }
      }
    }),
    signal: AbortSignal.timeout(35000)
  });

  const content = await parseResponse(response);
  if (!content) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content);
    return validator.parse(parsed);
  } catch {
    return undefined;
  }
}
