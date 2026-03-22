/**
 * outputScrubber — strips credentials and high-entropy secrets from tool results
 * before they enter LLM context.
 *
 * Two detection passes:
 *   1. Sensitive key names  — redacts values whose parent JSON key matches known secret patterns
 *   2. Known token prefixes — redacts strings that start with well-known API key prefixes
 *   3. Entropy analysis     — redacts strings ≥20 chars with Shannon entropy ≥3.8 bits/char
 *                             (after exempting safe patterns like hashes, UUIDs, paths)
 */

const SENSITIVE_KEY_RE = /^(api[_-]?key|apikey|secret|password|passwd|pw|token|bearer|authorization|auth[_-]?token|access[_-]?key|private[_-]?key|client[_-]?secret|webhook[_-]?secret|signing[_-]?key|encryption[_-]?key)$/i;

const KNOWN_PREFIX_RE = /^(sk-[A-Za-z0-9\-_]{10,}|sk-ant-[A-Za-z0-9\-_]{10,}|AIza[A-Za-z0-9\-_]{10,}|eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.]+|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|ghr_[A-Za-z0-9]{10,}|xoxb-[A-Za-z0-9\-]{10,}|xoxp-[A-Za-z0-9\-]{10,}|AKIA[A-Z0-9]{10,})/;

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

// Returns true for strings that look like safe non-secret content.
function isSafePattern(s: string): boolean {
  // Contains spaces → prose or code, not a key
  if (s.includes(" ")) return true;
  // URL
  if (/^https?:\/\//i.test(s)) return true;
  // File or relative path
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return true;
  // Pure hex (hash/digest): 32, 40, 56, or 64 hex chars
  if (/^[0-9a-f]{32,64}$/i.test(s) && /^[0-9a-f]+$/i.test(s)) return true;
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  // Base64 image data URI
  if (/^data:image\//i.test(s)) return true;
  // Version strings / semver
  if (/^\d+\.\d+(\.\d+)?(-[\w.]+)?$/.test(s)) return true;
  // ISO dates / timestamps
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(s)) return true;
  // All-lowercase identifier (env var names, config keys)
  if (/^[a-z][a-z0-9_-]*$/.test(s)) return true;
  // All-uppercase identifier
  if (/^[A-Z][A-Z0-9_-]*$/.test(s)) return true;
  return false;
}

function scrubString(value: string, parentKey?: string): string {
  // Pass 1: sensitive key name
  if (parentKey && SENSITIVE_KEY_RE.test(parentKey) && value.length > 0) {
    return "[REDACTED:sensitive-key]";
  }
  // Pass 2: known prefix patterns
  if (KNOWN_PREFIX_RE.test(value)) {
    return "[REDACTED:known-token-prefix]";
  }
  // Pass 3: entropy analysis
  if (
    value.length >= ENTROPY_MIN_LEN &&
    value.length <= ENTROPY_MAX_LEN &&
    !isSafePattern(value) &&
    shannonEntropy(value) >= ENTROPY_THRESHOLD
  ) {
    return "[REDACTED:high-entropy]";
  }
  return value;
}

function scrubNode(node: unknown, parentKey?: string): unknown {
  if (typeof node === "string") {
    return scrubString(node, parentKey);
  }
  if (Array.isArray(node)) {
    return node.map((item) => scrubNode(item));
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      out[key] = scrubNode(val, key);
    }
    return out;
  }
  return node;
}

/**
 * Scrub a tool result object before serialising it into the LLM message array.
 * Returns the same structure with credential-like strings replaced by [REDACTED:*] markers.
 */
export function scrubToolOutput(result: unknown): unknown {
  return scrubNode(result);
}

/**
 * Scrub a pre-serialised JSON string (fallback for places where we only have the
 * string form). Parses → scrubs → re-serialises. Falls back to the original string
 * on parse failure to avoid breaking the agent loop.
 */
export function scrubToolOutputJson(json: string): string {
  try {
    const parsed = JSON.parse(json);
    return JSON.stringify(scrubNode(parsed));
  } catch {
    return json;
  }
}
