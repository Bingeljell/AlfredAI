// Single source of truth for stripping credentials from data before it is
// stored (run telemetry, debug exports) or sent into LLM context. Consolidated
// from the former utils/redact + tools/outputScrubber pair.
//
// Four passes:
//   1. Sensitive key names  — a value whose parent JSON key names a secret is dropped
//   2. Known token prefixes — a string that *is* a known API key is dropped
//   3. Entropy analysis     — a high-entropy string (after safe-pattern exemptions) is dropped
//   4. Inline masking       — known keys embedded inside prose are masked in place

// Match only keys that ARE a secret identifier — not keys that merely contain these words
// (e.g. promptTokens, completionTokens, totalTokens must not be redacted).
const SECRET_KEY_REGEX = /^(api[_-]?key|apikey|secret|password|passwd|pw|token|bearer|authorization|auth[_-]?token|access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|client[_-]?secret|webhook[_-]?secret|signing[_-]?key|encryption[_-]?key|chatgpt-account-id|accountid)$/i;

// A string that is, in whole, a well-known API key.
const KNOWN_PREFIX_RE = /^(sk-ant-[A-Za-z0-9\-_]{10,}|sk-[A-Za-z0-9\-_]{10,}|AIza[A-Za-z0-9\-_]{10,}|eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.]+\.[A-Za-z0-9\-_.]+|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|ghr_[A-Za-z0-9]{10,}|xoxb-[A-Za-z0-9\-]{10,}|xoxp-[A-Za-z0-9\-]{10,}|AKIA[A-Z0-9]{10,})/;

// Known keys embedded inside a larger string (e.g. a log line or prose).
const INLINE_KEY_RE = /(sk-ant-[A-Za-z0-9\-_]{10,}|sk-[A-Za-z0-9\-_]{10,}|AIza[A-Za-z0-9\-_]{10,}|eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.]+\.[A-Za-z0-9\-_.]+|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|ghr_[A-Za-z0-9]{10,}|xoxb-[A-Za-z0-9\-]{10,}|xoxp-[A-Za-z0-9\-]{10,}|AKIA[A-Z0-9]{10,})/g;
const INLINE_BEARER_RE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\-/=]{8,}/gi;
const INLINE_AUTH_FIELD_RE = /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|chatgpt-account-id|accountId)\s*[:=]\s*[^\s,;]+/gi;

const ENTROPY_MIN_LEN = 20;
const ENTROPY_MAX_LEN = 512;
const ENTROPY_THRESHOLD = 3.8;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// True for strings that look like safe non-secret content and must not be entropy-redacted.
function isSafePattern(s: string): boolean {
  if (s.includes(" ")) return true;                                   // prose or code
  if (/^https?:\/\//i.test(s)) return true;                           // URL
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return true; // path
  if (/^[0-9a-f]{32,64}$/i.test(s)) return true;                      // hex hash/digest
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true; // UUID
  if (/^data:image\//i.test(s)) return true;                          // base64 image data URI
  if (/^\d+\.\d+(\.\d+)?(-[\w.]+)?$/.test(s)) return true;            // semver
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(s)) return true;       // ISO date/timestamp
  if (/^[a-z][a-z0-9_-]*$/.test(s)) return true;                      // lowercase identifier
  if (/^[A-Z][A-Z0-9_-]*$/.test(s)) return true;                      // uppercase identifier
  return false;
}

function redactString(value: string): string {
  if (KNOWN_PREFIX_RE.test(value)) {
    return "[REDACTED:known-token-prefix]";
  }
  if (
    value.length >= ENTROPY_MIN_LEN &&
    value.length <= ENTROPY_MAX_LEN &&
    !isSafePattern(value) &&
    shannonEntropy(value) >= ENTROPY_THRESHOLD
  ) {
    return "[REDACTED:high-entropy]";
  }
  return value
    .replace(INLINE_KEY_RE, "[REDACTED_KEY]")
    .replace(INLINE_BEARER_RE, "[REDACTED_AUTH]")
    .replace(INLINE_AUTH_FIELD_RE, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`);
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
      if (SECRET_KEY_REGEX.test(key) && typeof current === "string" && current.length > 0) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactValue(current);
      }
    }
    return output;
  }
  return value;
}
