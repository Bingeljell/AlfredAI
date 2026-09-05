import type { ConversationWindowEntry, RunRecord } from "../types.js";

/** Keep the newest complete pairs within a character budget, not fixed 1,200-char cuts. */
export function conversationWindow(runs: RunRecord[], budget = 24_000): ConversationWindowEntry[] {
  const chronological = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId));
  let reset = -1;
  chronological.forEach((run, index) => { if (run.message === "/newsession") reset = index; });
  const eligible = chronological.slice(reset + 1).filter((run) => !run.scheduler && run.status !== "queued" && run.status !== "running");
  const pairs: ConversationWindowEntry[][] = [];
  let remaining = budget;
  for (const run of eligible.reverse()) {
    const answer = run.status === "completed" ? run.assistantText ?? "" : `[${run.status}] ${run.assistantPreview ?? ""}\n${run.assistantText ?? ""}`.trim();
    const size = run.message.length + answer.length;
    if (size > remaining && pairs.length) break;
    const userBudget = Math.min(run.message.length, Math.floor(remaining / 2));
    const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, Math.max(0, max - 16))} …[truncated]`;
    const message = size <= remaining ? run.message : clip(run.message, userBudget);
    const content = clip(answer, remaining - message.length);
    pairs.unshift([
      { role: "user", content: message, runId: run.runId, timestamp: run.createdAt },
      { role: "assistant", content, runId: run.runId, timestamp: run.updatedAt }
    ]);
    remaining -= message.length + content.length;
    if (remaining <= 0) break;
  }
  return pairs.flat();
}
