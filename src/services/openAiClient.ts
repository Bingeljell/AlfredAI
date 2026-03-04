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

export type StructuredChatFailureCode =
  | "missing_api_key"
  | "network_error"
  | "http_error"
  | "empty_content"
  | "json_parse_error"
  | "zod_validation_error";

export interface StructuredChatDiagnostic<T> {
  result?: T;
  failureCode?: StructuredChatFailureCode;
  failureMessage?: string;
  statusCode?: number;
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
  const diagnostic = await runOpenAiStructuredChatWithDiagnostics(options, validator);
  return diagnostic.result;
}

export async function runOpenAiStructuredChatWithDiagnostics<T>(
  options: OpenAiStructuredChatOptions,
  validator: z.ZodType<T>
): Promise<StructuredChatDiagnostic<T>> {
  if (!options.apiKey) {
    return {
      failureCode: "missing_api_key",
      failureMessage: "OpenAI API key is not configured"
    };
  }

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
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
  } catch (error) {
    return {
      failureCode: "network_error",
      failureMessage: error instanceof Error ? error.message : "Network request failed"
    };
  }

  if (!response.ok) {
    return {
      failureCode: "http_error",
      failureMessage: `OpenAI returned status ${response.status}`,
      statusCode: response.status
    };
  }

  const content = await parseResponse(response);
  if (!content) {
    return {
      failureCode: "empty_content",
      failureMessage: "Structured response content was empty"
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    return {
      failureCode: "json_parse_error",
      failureMessage: "Model response was not valid JSON"
    };
  }

  try {
    return {
      result: validator.parse(parsedJson)
    };
  } catch (error) {
    return {
      failureCode: "zod_validation_error",
      failureMessage: error instanceof Error ? error.message : "Schema validation failed"
    };
  }
}
