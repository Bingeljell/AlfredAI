// Match only keys that ARE a secret identifier — not keys that merely contain these words
// (e.g. promptTokens, completionTokens, totalTokens must not be redacted)
const SECRET_KEY_REGEX = /^(api[_-]?key|apikey|secret|password|passwd|pw|token|bearer|authorization|auth[_-]?token|access[_-]?key|private[_-]?key|client[_-]?secret|webhook[_-]?secret|signing[_-]?key|encryption[_-]?key)$/i;
const OPENAI_KEY_REGEX = /sk-[A-Za-z0-9]{20,}/g;

function redactString(input: string): string {
  return input.replaceAll(OPENAI_KEY_REGEX, "[REDACTED_KEY]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, current] of Object.entries(record)) {
      if (SECRET_KEY_REGEX.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactValue(current);
      }
    }
    return output;
  }
  return value;
}
