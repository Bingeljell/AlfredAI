import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60_000;

interface PendingApproval {
  sessionId: string;
  actionKey: string;
  description: string;
  expiresAt: number;
}

export interface ApprovalRequest {
  token: string;
  description: string;
  expiresAt: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toolApprovalActionKey(toolName: string, input: unknown): string {
  return createHash("sha256").update(toolName).update("\0").update(canonical(input)).digest("hex");
}

export class ToolApprovalStore {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly approved = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS, private readonly now = Date.now) {}

  request(sessionId: string, actionKey: string, description: string): ApprovalRequest {
    this.prune();
    for (const [token, approval] of this.pending) {
      if (approval.sessionId === sessionId && approval.actionKey === actionKey) {
        return { token, description: approval.description, expiresAt: new Date(approval.expiresAt).toISOString() };
      }
    }
    const token = randomBytes(6).toString("hex");
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { sessionId, actionKey, description, expiresAt });
    return { token, description, expiresAt: new Date(expiresAt).toISOString() };
  }

  approve(sessionId: string, token: string): { ok: boolean; description?: string; reason?: string } {
    this.prune();
    const pending = this.pending.get(token);
    if (!pending || pending.sessionId !== sessionId) return { ok: false, reason: "approval_not_found_or_expired" };
    this.pending.delete(token);
    this.approved.set(`${sessionId}:${pending.actionKey}`, pending.expiresAt);
    return { ok: true, description: pending.description };
  }

  reject(sessionId: string, token: string): { ok: boolean; description?: string; reason?: string } {
    this.prune();
    const pending = this.pending.get(token);
    if (!pending || pending.sessionId !== sessionId) return { ok: false, reason: "approval_not_found_or_expired" };
    this.pending.delete(token);
    return { ok: true, description: pending.description };
  }

  consume(sessionId: string, actionKey: string): boolean {
    this.prune();
    const key = `${sessionId}:${actionKey}`;
    if (!this.approved.has(key)) return false;
    this.approved.delete(key);
    return true;
  }

  clear(): void {
    this.pending.clear();
    this.approved.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [token, approval] of this.pending) {
      if (approval.expiresAt <= now) this.pending.delete(token);
    }
    for (const [key, expiresAt] of this.approved) {
      if (expiresAt <= now) this.approved.delete(key);
    }
  }
}

export const toolApprovalStore = new ToolApprovalStore();
