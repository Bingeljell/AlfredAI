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
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as OpenAiResponse;
  return payload.choices?.[0]?.message?.content?.trim() || undefined;
}
