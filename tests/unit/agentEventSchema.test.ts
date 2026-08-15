import test from "node:test";
import assert from "node:assert/strict";
import { AgentEventSchema, AGENT_EVENT_TYPES } from "../../src/agentEvents/schema.js";

const VALID_EVENT = {
  version: "1.0",
  source: "herdr",
  agentKind: "pi",
  workspaceId: "w9",
  paneId: "p2",
  eventType: "needs_approval",
  timestamp: 1755271200000,
  payload: {
    promptText: "Allow command: git push origin main [y/n]?",
    suggestedAction: "confirm",
    cwd: "/Users/yourname/projects/AlfredAI",
    details: "git push origin main"
  }
};

test("accepts a fully-formed spec event", () => {
  const parsed = AgentEventSchema.safeParse(VALID_EVENT);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.eventType, "needs_approval");
  assert.equal(parsed.data.payload?.promptText, "Allow command: git push origin main [y/n]?");
});

test("defaults version and accepts missing timestamp, sessionId, and payload", () => {
  const minimal = {
    source: "tmux",
    agentKind: "codex",
    workspaceId: "w1",
    paneId: "p3",
    eventType: "completed"
  };
  const parsed = AgentEventSchema.safeParse(minimal);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.version, "1.0");
  assert.equal(parsed.data.timestamp, undefined);
  assert.equal(parsed.data.payload, undefined);
});

test("accepts every event type and allows unknown payload keys", () => {
  for (const eventType of AGENT_EVENT_TYPES) {
    const parsed = AgentEventSchema.safeParse({
      source: "hook",
      agentKind: "claude-code",
      workspaceId: "w9",
      paneId: "p1",
      eventType,
      payload: { arbitraryKey: "preserved", ping: true }
    });
    assert.equal(parsed.success, true, `expected ${eventType} to validate`);
    if (!parsed.success) continue;
    assert.equal(parsed.data.payload?.arbitraryKey, "preserved");
  }
});

test("rejects unknown event types", () => {
  const result = AgentEventSchema.safeParse({ ...VALID_EVENT, eventType: "exploded" });
  assert.equal(result.success, false);
});

test("rejects missing required fields and invalid timestamps", () => {
  const missingSource = AgentEventSchema.safeParse({ ...VALID_EVENT, source: undefined });
  assert.equal(missingSource.success, false);

  const negativeTimestamp = AgentEventSchema.safeParse({ ...VALID_EVENT, timestamp: -5 });
  assert.equal(negativeTimestamp.success, false);

  const fractionalTimestamp = AgentEventSchema.safeParse({ ...VALID_EVENT, timestamp: 1.5 });
  assert.equal(fractionalTimestamp.success, false);
});
