const SECRET_KEY_REGEX = /(key|token|secret|password|authorization)/i;
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
