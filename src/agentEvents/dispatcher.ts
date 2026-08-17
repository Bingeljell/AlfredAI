/**
 * agentEvents/dispatcher — routes validated agent events to their handlers.
 *
 * Routing (per docs/architecture/agent_event_webhook_spec.md §4):
 *   - needs_approval → immediate actionable Telegram push with /approve hints.
 *   - failed         → error alert push.
 *   - completed      → recorded; Telegram push only when the producer marked
 *                      the event for a proactive ping (payload.ping).
 *   - progress       → recorded only (optional milestone; no push).
 *
 * Every event is persisted to the AgentEventStore first (best effort) so the
 * dispatch outcome never depends on notification delivery.
 */

import type { AgentEvent, AgentEventType } from "./schema.js";
import type { AgentEventNotifier } from "./notifier.js";

/** Structural dependency so tests can inject fakes without the store class. */
export interface AgentEventStoreLike {
  append(event: AgentEvent): Promise<string>;
}

export interface AgentEventDispatchResult {
  eventType: AgentEventType;
  handled: boolean;
  notified: boolean;
  notification?: string;
  reason?: string;
}

export interface AgentEventDispatcherDeps {
  notifier: AgentEventNotifier;
  store?: AgentEventStoreLike;
}

export interface AgentEventSchedulerHook {
  handleAgentEvent(event: AgentEvent): Promise<void>;
}

function locationOf(event: AgentEvent): string {
  return `${event.workspaceId}:${event.paneId}`;
}

function agentLabel(event: AgentEvent): string {
  return `${event.agentKind} / ${event.source}`;
}

function promptOf(event: AgentEvent): string {
  return event.payload?.promptText ?? event.payload?.details ?? "(no prompt provided)";
}

export function formatApprovalAlert(event: AgentEvent): string {
  const lines = [
    `🚨 **Approval Required in \`${locationOf(event)}\` (${agentLabel(event)}):**`,
    "",
    promptOf(event)
  ];
  if (event.payload?.suggestedAction) {
    lines.push("", `Suggested action: \`${event.payload.suggestedAction}\``);
  }
  lines.push("", `Reply \`/approve ${locationOf(event)}\` or \`/reject ${locationOf(event)}\`.`);
  return lines.join("\n");
}

export function formatFailureAlert(event: AgentEvent): string {
  const detail =
    event.payload?.error ??
    event.payload?.details ??
    "Agent terminated unexpectedly";
  const exit = typeof event.payload?.exitCode === "number" ? ` (exit code ${event.payload.exitCode})` : "";
  return `❌ **Agent Failed in \`${locationOf(event)}\` (${agentLabel(event)}):**\n\n${detail}${exit}`;
}

export function formatCompletionNotice(event: AgentEvent): string {
  const detail = event.payload?.details ?? "Objective finished.";
  return `✅ **Agent Completed in \`${locationOf(event)}\` (${agentLabel(event)}):**\n\n${detail}`;
}

export class AgentEventDispatcher {
  private schedulerHook?: AgentEventSchedulerHook;

  constructor(private readonly deps: AgentEventDispatcherDeps) {}

  setSchedulerHook(hook: AgentEventSchedulerHook): void {
    this.schedulerHook = hook;
  }

  async dispatch(event: AgentEvent): Promise<AgentEventDispatchResult> {
    try {
      await this.deps.store?.append(event);
    } catch {
      // Persistence is best-effort — notification routing must still run.
    }

    const base = { eventType: event.eventType, handled: true };

    let result: AgentEventDispatchResult;
    switch (event.eventType) {
      case "needs_approval": {
        const notification = formatApprovalAlert(event);
        await this.deps.notifier.send(notification);
        result = { ...base, notified: true, notification, reason: "approval_pushed" };
        break;
      }
      case "failed": {
        const notification = formatFailureAlert(event);
        await this.deps.notifier.send(notification);
        result = { ...base, notified: true, notification, reason: "failure_pushed" };
        break;
      }
      case "completed": {
        if (event.payload?.ping === true) {
          const notification = formatCompletionNotice(event);
          await this.deps.notifier.send(notification);
          result = { ...base, notified: true, notification, reason: "completion_pushed" };
          break;
        }
        result = { ...base, notified: false, reason: "completion_not_marked_for_ping" };
        break;
      }
      case "progress":
        result = { ...base, notified: false, reason: "progress_recorded" };
        break;
    }
    try {
      await this.schedulerHook?.handleAgentEvent(event);
    } catch {
      // Event notification remains successful if scheduler nudging fails.
    }
    return result;
  }
}
