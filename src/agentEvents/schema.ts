/**
 * agentEvents/schema — Zod schema and types for the Agent Event Webhook
 * contract (docs/architecture/agent_event_webhook_spec.md).
 *
 * External agents / terminal wrappers (Herdr, tmux/Zellij hooks, standalone
 * agent hooks) POST events here so Alfred can react to status transitions and
 * approval gates without polling.
 */

import { z } from "zod";

export const AGENT_EVENT_TYPES = ["needs_approval", "completed", "failed", "progress"] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

const AgentEventPayloadSchema = z
  .object({
    promptText: z.string().max(4000).optional(),
    suggestedAction: z.string().max(200).optional(),
    cwd: z.string().max(600).optional(),
    details: z.string().max(4000).optional(),
    error: z.string().max(4000).optional(),
    exitCode: z.number().int().optional(),
    // Proactive-ping marker: producers set true to force a Telegram push for
    // otherwise quiet transitions (e.g. a long `completed` run).
    ping: z.boolean().optional()
  })
  .passthrough();

export const AgentEventSchema = z.object({
  version: z.string().default("1.0"),
  source: z.string().min(1).max(60),
  agentKind: z.string().min(1).max(60),
  workspaceId: z.string().min(1).max(120),
  paneId: z.string().min(1).max(120),
  sessionId: z.string().min(1).max(200).optional(),
  eventType: z.enum(AGENT_EVENT_TYPES),
  timestamp: z.number().int().positive().optional(),
  payload: AgentEventPayloadSchema.optional()
});

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventPayload = NonNullable<AgentEvent["payload"]>;
