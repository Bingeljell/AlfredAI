/**
 * outputScrubber — strips credentials and high-entropy secrets from tool results
 * before they enter LLM context.
 *
 * The detection logic lives in utils/redact.ts (the single source of truth shared
 * with run telemetry and debug exports). This module is a thin, well-named entry
 * point for the LLM-context path.
 */
import { redactValue } from "../utils/redact.js";

/**
 * Scrub a tool result object before serialising it into the LLM message array.
 * Returns the same structure with credential-like strings replaced by [REDACTED:*] markers.
 */
export function scrubToolOutput(result: unknown): unknown {
  return redactValue(result);
}

/**
 * Scrub a pre-serialised JSON string (fallback for places where we only have the
 * string form). Parses → scrubs → re-serialises. Falls back to the original string
 * on parse failure to avoid breaking the agent loop.
 */
export function scrubToolOutputJson(json: string): string {
  try {
    return JSON.stringify(redactValue(JSON.parse(json)));
  } catch {
    return json;
  }
}
