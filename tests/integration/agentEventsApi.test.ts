import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../../src/gateway/app.js";

const AGENT_EVENT_TOKEN = "test-agent-event-token";

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
    cwd: "/Users/nikhilshahane/projects/AlfredAI",
    details: "git push origin main"
  }
};

async function postAgentEvent(body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers["X-Agent-Event-Token"] = token;
  }
  return app.request("http://localhost/api/events/agent", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("POST /api/events/agent accepts a valid event and dispatches an approval alert", async () => {
  const res = await postAgentEvent(VALID_EVENT, AGENT_EVENT_TOKEN);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.handled, true);
  assert.equal(body.notified, true);
  assert.equal(body.reason, "approval_pushed");
  assert.match(String(body.notification ?? ""), /Approval Required in `w9:p2`/);
  assert.match(String(body.notification ?? ""), /\/approve w9:p2/);
});

test("POST /api/events/agent records quiet completions without a push", async () => {
  const res = await postAgentEvent(
    {
      source: "tmux",
      agentKind: "codex",
      workspaceId: "w1",
      paneId: "p3",
      eventType: "completed",
      payload: { details: "Finished cleanly." }
    },
    AGENT_EVENT_TOKEN
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.notified, false);
  assert.equal(body.reason, "completion_not_marked_for_ping");
});

test("POST /api/events/agent rejects missing or wrong tokens", async () => {
  const noToken = await postAgentEvent(VALID_EVENT);
  assert.equal(noToken.status, 401);

  const wrongToken = await postAgentEvent(VALID_EVENT, "not-the-token");
  assert.equal(wrongToken.status, 401);
});

test("POST /api/events/agent returns 400 for malformed JSON and invalid schema", async () => {
  const badJson = await postAgentEvent("{not json", AGENT_EVENT_TOKEN);
  assert.equal(badJson.status, 400);

  const badEventType = await postAgentEvent({ ...VALID_EVENT, eventType: "exploded" }, AGENT_EVENT_TOKEN);
  assert.equal(badEventType.status, 400);
  const details = (await badEventType.json()) as { details?: Array<{ path: Array<string | number> }> };
  assert.ok(Array.isArray(details.details));
  assert.ok(details.details.length > 0);

  const missingSource = await postAgentEvent({ ...VALID_EVENT, source: undefined }, AGENT_EVENT_TOKEN);
  assert.equal(missingSource.status, 400);
});
