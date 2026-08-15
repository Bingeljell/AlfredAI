/**
 * agentEvents/auth — ingress authentication for POST /api/events/agent.
 *
 * Per the spec, the endpoint accepts either a shared local secret
 * (`X-Agent-Event-Token` header, constant-time compared) or, when no secret is
 * configured, loopback-only callers (127.0.0.1 / ::1). If a secret IS
 * configured it always wins — loopback is not a bypass.
 */

import { timingSafeEqual } from "node:crypto";

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function safeKeyEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export interface AuthorizeAgentEventArgs {
  remoteAddress: string | null | undefined;
  providedToken: string | null | undefined;
  configuredToken: string | null | undefined;
}

export function authorizeAgentEvent(args: AuthorizeAgentEventArgs): boolean {
  const configured = args.configuredToken?.trim();
  if (configured) {
    const provided = args.providedToken?.trim();
    return provided !== undefined && provided.length > 0 && safeKeyEqual(provided, configured);
  }
  return isLoopbackAddress(args.remoteAddress);
}
