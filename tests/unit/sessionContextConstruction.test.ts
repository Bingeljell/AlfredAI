import test from "node:test";
import assert from "node:assert/strict";
import { buildInitialConversationMessages } from "../../src/runtime/agentLoop.js";
import type { SessionPromptContext } from "../../src/types.js";

test("canonical conversation history excludes duplicate summaries and keeps the current request last", () => {
  const currentRequest = "Dig in and fix. Then we can go back to multimodal capabilities";
  const staleRequest = "How do we fix that?";
  const staleReply = "Good question. This is a Telegram bot capability gap.";
  const context: SessionPromptContext = {
    activeObjective: currentRequest,
    sessionSummary: `Active objective: ${currentRequest} | Latest outcome: ${staleReply}`,
    recentTurns: [
      { role: "user", content: staleRequest, runId: "old", timestamp: "2026-08-25T14:36:00.000Z" },
      { role: "assistant", content: staleReply, runId: "old", timestamp: "2026-08-25T14:37:00.000Z" },
      { role: "user", content: currentRequest, runId: "current", timestamp: "2026-08-25T15:08:00.000Z" }
    ],
    conversationWindow: [
      { role: "user", content: staleRequest, runId: "old", timestamp: "2026-08-25T14:36:00.000Z" },
      { role: "assistant", content: staleReply, runId: "old", timestamp: "2026-08-25T14:37:00.000Z" }
    ]
  };

  const messages = buildInitialConversationMessages("system prompt", currentRequest, context);

  assert.deepEqual(messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: staleRequest },
    { role: "assistant", content: staleReply },
    { role: "user", content: currentRequest }
  ]);
  assert.equal(messages.filter((message) => message.content === currentRequest).length, 1);
});

test("legacy summary context is separated from the authoritative current request", () => {
  const messages = buildInitialConversationMessages("system prompt", "current request", {
    activeObjective: "previous objective",
    sessionSummary: "previous outcome"
  });

  assert.equal(messages.at(-1)?.role, "user");
  assert.equal(messages.at(-1)?.content, "current request");
  assert.match(messages[1]?.content ?? "", /background only/);
  assert.doesNotMatch(messages[1]?.content ?? "", /current request/);
});
