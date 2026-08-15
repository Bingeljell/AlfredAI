import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentEventDispatcher,
  formatApprovalAlert
} from "../../src/agentEvents/dispatcher.js";
import type { AgentEvent } from "../../src/agentEvents/schema.js";

class FakeNotifier {
  sent: string[] = [];

  async send(text: string): Promise<void> {
    this.sent.push(text);
  }
}

class FakeStore {
  appended: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<string> {
    this.appended.push(event);
    return "2026-08-15T00:00:00.000Z";
  }
}

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    version: "1.0",
    source: "herdr",
    agentKind: "pi",
    workspaceId: "w9",
    paneId: "p2",
    eventType: "needs_approval",
    payload: {
      promptText: "Allow command: git push origin main [y/n]?"
    },
    ...overrides
  };
}

test("needs_approval pushes an actionable alert with /approve hints", async () => {
  const notifier = new FakeNotifier();
  const store = new FakeStore();
  const dispatcher = new AgentEventDispatcher({ notifier, store });

  const result = await dispatcher.dispatch(
    makeEvent({ payload: { promptText: "Allow command: git push origin main [y/n]?", suggestedAction: "confirm" } })
  );

  assert.equal(result.handled, true);
  assert.equal(result.notified, true);
  assert.equal(result.reason, "approval_pushed");
  assert.equal(notifier.sent.length, 1);
  const message = notifier.sent[0] ?? "";
  assert.match(message, /🚨 \*\*Approval Required in `w9:p2`/);
  assert.match(message, /Allow command: git push origin main \[y\/n\]\?/);
  assert.match(message, /Suggested action: `confirm`/);
  assert.match(message, /`\/approve w9:p2` or `\/reject w9:p2`/);
  assert.equal(store.appended.length, 1);
});

test("failed pushes an error alert including exit code", async () => {
  const notifier = new FakeNotifier();
  const dispatcher = new AgentEventDispatcher({ notifier });

  const result = await dispatcher.dispatch(
    makeEvent({
      eventType: "failed",
      payload: { error: "panic: index out of range", exitCode: 1 }
    })
  );

  assert.equal(result.notified, true);
  assert.equal(result.reason, "failure_pushed");
  assert.match(notifier.sent[0] ?? "", /❌ \*\*Agent Failed in `w9:p2`/);
  assert.match(notifier.sent[0] ?? "", /panic: index out of range \(exit code 1\)/);
});

test("completed is recorded but only pushes when payload.ping is true", async () => {
  const notifier = new FakeNotifier();
  const store = new FakeStore();
  const dispatcher = new AgentEventDispatcher({ notifier, store });

  const quiet = await dispatcher.dispatch(
    makeEvent({ eventType: "completed", payload: { details: "Done." } })
  );
  assert.equal(quiet.notified, false);
  assert.equal(quiet.reason, "completion_not_marked_for_ping");
  assert.equal(notifier.sent.length, 0);

  const pinged = await dispatcher.dispatch(
    makeEvent({ eventType: "completed", payload: { details: "Long build finished.", ping: true } })
  );
  assert.equal(pinged.notified, true);
  assert.equal(pinged.reason, "completion_pushed");
  assert.match(notifier.sent[0] ?? "", /✅ \*\*Agent Completed in `w9:p2`/);
  assert.equal(store.appended.length, 2);
});

test("progress is recorded without a push", async () => {
  const notifier = new FakeNotifier();
  const dispatcher = new AgentEventDispatcher({ notifier });

  const result = await dispatcher.dispatch(
    makeEvent({ eventType: "progress", payload: { details: "12% done" } })
  );

  assert.equal(result.handled, true);
  assert.equal(result.notified, false);
  assert.equal(result.reason, "progress_recorded");
  assert.equal(notifier.sent.length, 0);
});

test("dispatch still routes when the store fails", async () => {
  const notifier = new FakeNotifier();
  const dispatcher = new AgentEventDispatcher({
    notifier,
    store: {
      append: async () => {
        throw new Error("disk full");
      }
    }
  });

  const result = await dispatcher.dispatch(makeEvent());
  assert.equal(result.notified, true);
  assert.equal(result.reason, "approval_pushed");
});

test("formatApprovalAlert matches the spec example shape", () => {
  const event = makeEvent({
    payload: {
      promptText: "Allow command: git push origin main [y/n]?",
      suggestedAction: "confirm",
      cwd: "/Users/yourname/projects/AlfredAI",
      details: "git push origin main"
    }
  });
  const text = formatApprovalAlert(event);
  assert.equal(
    text,
    [
      "🚨 **Approval Required in `w9:p2` (pi / herdr):**",
      "",
      "Allow command: git push origin main [y/n]?",
      "",
      "Suggested action: `confirm`",
      "",
      "Reply `/approve w9:p2` or `/reject w9:p2`."
    ].join("\n")
  );
});
