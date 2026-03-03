import { randomUUID } from "node:crypto";
import type { PolicyMode } from "../types.js";

const HIGH_RISK_PATTERNS = [
  /send\s+email/i,
  /system\s+command/i,
  /shell/i,
  /delete\s+/i,
  /rm\s+-/i,
  /restart\s+service/i,
  /kill\s+process/i
];

export interface ApprovalDecision {
  needed: boolean;
  token?: string;
  reason?: string;
}

export function evaluateApprovalNeed(message: string, mode: PolicyMode): ApprovalDecision {
  if (mode === "trusted") {
    return { needed: false };
  }

  const matched = HIGH_RISK_PATTERNS.find((pattern) => pattern.test(message));
  if (!matched) {
    return { needed: false };
  }

  return {
    needed: true,
    token: randomUUID().slice(0, 8),
    reason: "Balanced mode requires approval for risky actions"
  };
}
