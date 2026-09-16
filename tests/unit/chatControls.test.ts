import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, AgentTurnRequest } from "../../src/runtime/agentRuntime.js";
import { ChatService } from "../../src/runner/chatService.js";
import { InMemoryQueue } from "../../src/workers/inMemoryQueue.js";
import { RunStore } from "../../src/runs/runStore.js";
import { SessionStore } from "../../src/memory/sessionStore.js";
import type { CodexModel, CodexRateLimitSnapshot, CodexSubscriptionUsage } from "../../src/provider/codex/subscriptionService.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";
import { toolApprovalActionKey, toolApprovalStore } from "../../src/runtime/toolApprovalStore.js";

const models: CodexModel[] = [
  { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "", hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "quick" }, { reasoningEffort: "medium", description: "balanced" }], inputModalities: ["text"] },
  { id: "gpt-5.6-pro", model: "gpt-5.6-pro", displayName: "GPT-5.6 Pro", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "balanced" }, { reasoningEffort: "high", description: "deep" }], inputModalities: ["text"] },
  { id: "gpt-5.6-mini", model: "gpt-5.6-mini", displayName: "GPT-5.6 Mini", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "quick" }], inputModalities: ["text"] },
  { id: "gpt-5.5-codex", model: "gpt-5.5-codex", displayName: "GPT-5.5 Codex", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "deep" }], inputModalities: ["text"] },
  { id: "gpt-4o", model: "gpt-4o", displayName: "GPT-4o", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "", supportedReasoningEfforts: [], inputModalities: ["text"] },
  { id: "claude-sol", model: "claude-sol", displayName: "Claude Sol", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "quick" }], inputModalities: ["text"] },
  { id: "gemini-pro", model: "gemini-pro", displayName: "Gemini Pro", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "balanced" }], inputModalities: ["text"] },
  { id: "local-model", model: "local-model", displayName: "Local Model", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "quick" }], inputModalities: ["text"] }
];

function clearRateLimits(): CodexRateLimitSnapshot {
  return { limitId: "codex", limitName: "Codex", planType: "plus", primary: { usedPercent: 25, resetsAt: 1_800_000_000, windowDurationMins: 300 }, secondary: null, reachedType: null, credits: null };
}

function usage(): CodexSubscriptionUsage {
  return { rateLimits: clearRateLimits(), usage: { summary: { lifetimeTokens: 10_000, peakDailyTokens: 500, currentStreakDays: null, longestStreakDays: null, longestRunningTurnSec: null }, dailyUsageBuckets: [] } };
}

function makeService(workspace: string, options: { liveModels?: () => CodexModel[]; rateLimits?: () => CodexRateLimitSnapshot } = {}) {
  const sessionStore = new SessionStore(workspace);
  const runStore = new RunStore(workspace);
  const requests: AgentTurnRequest[] = [];
  const agentRuntime: AgentRuntime = {
    async runTurn(request) {
      requests.push(request);
      return { status: "completed", assistantText: "model response" };
    }
  };
  const subscriptionService = {
    async listModels() { return options.liveModels?.() ?? models; },
    async readRateLimits() { return options.rateLimits?.() ?? clearRateLimits(); },
    async readUsage() { return usage(); }
  };
  const chat = new ChatService({
    sessionStore,
    runStore,
    searchManager: {} as never,
    queue: new InMemoryQueue(2),
    workspaceDir: workspace,
    searchMaxResults: 15,
    fastScrapeCount: 5,
    enablePlaywright: false,
    maxSteps: 4,
    browseConcurrency: 3,
    agentMaxDurationMs: 60_000,
    agentMaxToolCalls: 8,
    agentMaxParallelTools: 2,
    agentRuntime,
    subscriptionService,
    globalModel: "gpt-5.6-sol"
  });
  return { chat, sessionStore, runStore, requests, subscriptionService };
}

test("ChatService model and reasoning controls persist per session and never enter conversation history", async () => {
  const workspace = await createTempWorkspace("chat-controls");
  const setup = makeService(workspace);
  const session = await setup.sessionStore.createSession("Controls");

  const listed = await setup.chat.handleTurn({ sessionId: session.id, message: "/model" });
  assert.equal(listed.runId, "");
  assert.match(listed.assistantText ?? "", /Models 1\/2:/);
  assert.match(listed.assistantText ?? "", /6\. Claude Sol/);
  assert.equal((await setup.runStore.listRuns(session.id)).length, 0);

  const ambiguous = await setup.chat.handleTurn({ sessionId: session.id, message: "/model sol" });
  assert.match(ambiguous.assistantText ?? "", /ambiguous/);
  assert.match(ambiguous.assistantText ?? "", /gpt-5\.6-sol/);
  assert.match(ambiguous.assistantText ?? "", /claude-sol/);

  await setup.chat.handleTurn({ sessionId: session.id, message: "/model 2" });
  assert.deepEqual((await setup.sessionStore.getSession(session.id))?.preferences, { modelId: "gpt-5.6-pro" });
  const reasoning = await setup.chat.handleTurn({ sessionId: session.id, message: "/reasoning" });
  assert.match(reasoning.assistantText ?? "", /1\. medium/);
  assert.match(reasoning.assistantText ?? "", /2\. high/);
  await setup.chat.handleTurn({ sessionId: session.id, message: "/reasoning 2" });
  assert.deepEqual((await setup.sessionStore.getSession(session.id))?.preferences, { modelId: "gpt-5.6-pro", reasoningEffort: "high" });

  const unsupported = await setup.chat.handleTurn({ sessionId: session.id, message: "/reasoning xhigh" });
  assert.match(unsupported.assistantText ?? "", /not supported/);
  assert.equal((await setup.sessionStore.getSession(session.id))?.preferences?.reasoningEffort, "high");
  await setup.chat.handleTurn({ sessionId: session.id, message: "/reasoning default" });
  await setup.chat.handleTurn({ sessionId: session.id, message: "/model default" });
  assert.equal((await setup.sessionStore.getSession(session.id))?.preferences, undefined);

  const normal = await setup.chat.handleTurn({ sessionId: session.id, message: "do work" });
  assert.equal(normal.status, "completed");
  assert.equal(setup.requests[0]?.modelSelection?.modelId, "gpt-5.6-sol");
  const saved = await setup.sessionStore.getSession(session.id);
  assert.deepEqual(saved?.workingMemory?.conversationWindow?.map((entry) => entry.content), ["do work", "model response"]);
  assert.equal(saved?.workingMemory?.conversationWindow?.some((entry) => entry.content.includes("/model")), false);
});

test("ChatService controls have identical channel-facing behavior and live numbering", async () => {
  const workspace = await createTempWorkspace("chat-controls-parity");
  const setup = makeService(workspace);
  const webSession = await setup.sessionStore.createSession("Web");
  const telegramSession = await setup.sessionStore.createSession("Telegram");
  const webModel = await setup.chat.handleTurn({ sessionId: webSession.id, message: "/model page 2" });
  const telegramModel = await setup.chat.handleTurn({ sessionId: telegramSession.id, message: "/model page 2" });
  assert.equal(webModel.assistantText, telegramModel.assistantText);
  const webReasoning = await setup.chat.handleTurn({ sessionId: webSession.id, message: "/reasoning" });
  const telegramReasoning = await setup.chat.handleTurn({ sessionId: telegramSession.id, message: "/reasoning" });
  assert.equal(webReasoning.assistantText, telegramReasoning.assistantText);
});

test("ChatService approvals are one-use, session-bound controls outside conversation history", async () => {
  toolApprovalStore.clear();
  const workspace = await createTempWorkspace("chat-controls-approval");
  const setup = makeService(workspace);
  const session = await setup.sessionStore.createSession("Approval");
  const other = await setup.sessionStore.createSession("Other");
  const actionKey = toolApprovalActionKey("shell_exec", { command: "pwd" });
  const pending = toolApprovalStore.request(session.id, actionKey, "shell_exec: pwd");

  const wrongSession = await setup.chat.handleTurn({ sessionId: other.id, message: `/approve ${pending.token}` });
  assert.match(wrongSession.assistantText ?? "", /not found/);
  const approved = await setup.chat.handleTurn({ sessionId: session.id, message: `/approve ${pending.token}` });
  assert.match(approved.assistantText ?? "", /Approved once/);
  assert.equal(toolApprovalStore.consume(session.id, actionKey), true);
  assert.equal(toolApprovalStore.consume(session.id, actionKey), false);
  assert.equal((await setup.runStore.listRuns(session.id)).length, 0);
});

test("ChatService reports disappeared models and invalid saved effort explicitly", async () => {
  const workspace = await createTempWorkspace("chat-controls-fallback");
  const liveModels = [...models];
  const setup = makeService(workspace, { liveModels: () => liveModels });
  const session = await setup.sessionStore.createSession("Fallback");
  await setup.sessionStore.setPreferences(session.id, { modelId: "gpt-5.6-pro", reasoningEffort: "high" });
  liveModels.splice(1, 1);
  const result = await setup.chat.handleTurn({ sessionId: session.id, message: "continue" });
  assert.match(result.assistantText ?? "", /no longer available/);
  assert.match(result.assistantText ?? "", /not supported/);
  assert.equal(setup.requests[0]?.modelSelection?.modelId, "gpt-5.6-sol");
  assert.equal((await setup.sessionStore.getSession(session.id))?.preferences, undefined);
});

test("ChatService blocks reached subscription limits before starting a model turn and separates /usage", async () => {
  const workspace = await createTempWorkspace("chat-controls-usage");
  let reached = false;
  const setup = makeService(workspace, {
    rateLimits: () => reached
      ? { ...clearRateLimits(), limitName: "primary quota", reachedType: "primary", primary: { usedPercent: 100, resetsAt: 1_900_000_000, windowDurationMins: 300 } }
      : clearRateLimits()
  });
  const session = await setup.sessionStore.createSession("Usage");
  reached = true;
  const blocked = await setup.chat.handleTurn({ sessionId: session.id, message: "blocked work" });
  assert.equal(blocked.status, "failed");
  assert.match(blocked.assistantText ?? "", /primary quota/);
  assert.match(blocked.assistantText ?? "", /Reset: 2030/);
  assert.equal(setup.requests.length, 0);

  reached = false;
  const completed = await setup.chat.handleTurn({ sessionId: session.id, message: "allowed work" });
  assert.equal(completed.status, "completed");
  const run = (await setup.runStore.listRuns(session.id))[0];
  assert.ok(run);
  await setup.runStore.addLlmUsage(run!.runId, { promptTokens: 20, completionTokens: 22, totalTokens: 42 }, 1);
  await Promise.all(Array.from({ length: 101 }, async (_, index) => {
    const extraRun = await setup.runStore.createRun(session.id, `historical run ${index}`, "completed");
    await setup.runStore.addLlmUsage(extraRun.runId, { promptTokens: 0, completionTokens: 0, totalTokens: 1 }, 1);
  }));
  const usageResponse = await setup.chat.handleTurn({ sessionId: session.id, message: "/usage" });
  assert.match(usageResponse.assistantText ?? "", /ChatGPT subscription usage/);
  assert.match(usageResponse.assistantText ?? "", /Alfred local session token usage: 143 tokens/);
  assert.match(usageResponse.assistantText ?? "", /separate from subscription quota/);
});
