import { z } from "zod";
import { AssistantTextStream } from "./assistantTextStream.js";
import type { PolicyMode, RunOutcome, SessionPromptContext } from "../types.js";
import type { ToolContext, ToolState } from "../tools/types.js";
import { applyToolAllowlist, discoverTools, executeToolWithEnvelope, type ToolExecutionEnvelope } from "../tools/registry.js";
import { scrubToolOutput } from "../tools/outputScrubber.js";
import { evaluateApprovalNeed } from "./approvalPolicy.js";
import { ALFRED_AGENT } from "./specialists.js";
import type { AgentRuntime, AgentRuntimeServices, AgentTurnRequest } from "./agentRuntime.js";
import { getPolicyMode } from "../config/env.js";
import type { CodexModel, CodexSubscriptionService } from "../provider/codex/subscriptionService.js";
import { reachedRateLimit } from "../runner/chatControls.js";
import { CodexAppServerLlmProvider } from "../provider/codex/appServerLlmProvider.js";
import { runSafeAppServerTurn, type AppServerClientFactory, type DynamicToolCallParams } from "../provider/codex/appServerTurn.js";

function nowIso(): string { return new Date().toISOString(); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : "Codex App Server runtime failed").slice(0, 300); }

function rateLimitMessage(reached: ReturnType<typeof reachedRateLimit>): string | undefined {
  if (!reached) return undefined;
  const reset = reached.resetAt ? ` Reset: ${new Date(reached.resetAt * 1_000).toISOString()}.` : "";
  return `ChatGPT subscription limit reached for ${reached.bucket} (${reached.reachedType}).${reset} Use /usage for the current quota.`;
}

function sessionContextText(context: SessionPromptContext): string {
  const parts = [context.activeObjective && `Active objective: ${context.activeObjective}`, context.sessionSummary && `Session context: ${context.sessionSummary}`].filter(Boolean);
  if (context.recentTurns?.length) parts.push(`Recent turns:\n${context.recentTurns.slice(-3).map((turn) => `- ${turn.role}: ${String(turn.content).slice(0, 200)}`).join("\n")}`);
  return parts.join("\n\n");
}

function historyItems(context?: SessionPromptContext): unknown[] {
  return (context?.conversationWindow ?? []).map((entry) => ({
    type: "message",
    role: entry.role,
    content: [{ type: entry.role === "user" ? "input_text" : "output_text", text: entry.content }]
  }));
}

function dynamicSpecs(tools: Map<string, { name: string; description: string; inputSchema: z.ZodTypeAny }>) {
  return Array.from(tools.values()).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>
  }));
}

function dynamicResponse(envelope: ToolExecutionEnvelope): Record<string, unknown> {
  return { success: envelope.status === "ok", contentItems: [{ type: "inputText", text: JSON.stringify({ status: envelope.status, result: scrubToolOutput(envelope.result), error: envelope.error }) }] };
}

export interface CodexAppServerRuntimeOptions extends AgentRuntimeServices {
  subscriptionService: CodexSubscriptionService;
  defaultModel: string;
  policyMode?: PolicyMode;
  clientFactory?: AppServerClientFactory;
}

export class CodexAppServerRuntime implements AgentRuntime {
  private modelCache?: { models: CodexModel[]; expiresAt: number };
  constructor(private readonly options: CodexAppServerRuntimeOptions) {}

  private async models(): Promise<CodexModel[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) return this.modelCache.models;
    const models = await this.options.subscriptionService.listModels();
    this.modelCache = { models, expiresAt: Date.now() + 30_000 };
    return models;
  }

  async runTurn(request: AgentTurnRequest): Promise<RunOutcome> {
    const runStore = this.options.runStore;
    const policyMode = this.options.policyMode ?? getPolicyMode();
    const profile = request.executionProfile;
    const schedulerTurn = profile?.origin === "scheduler";
    const maxDurationMs = profile?.maxDurationMs ?? this.options.agentMaxDurationMs;
    const maxToolCalls = profile?.maxToolCalls ?? this.options.agentMaxToolCalls;
    await runStore.appendEvent({ runId: request.runId, sessionId: request.sessionId, phase: "session", eventType: "loop_started", payload: { runtime: "codex_app_server", maxDurationMs, maxToolCalls }, timestamp: nowIso() });

    const approval = schedulerTurn ? { needed: false as const } : evaluateApprovalNeed(request.message, policyMode);
    if (approval.needed) {
      await runStore.appendEvent({ runId: request.runId, sessionId: request.sessionId, phase: "approval", eventType: "approval_required", payload: { reason: approval.reason, token: approval.token }, timestamp: nowIso() });
      return { status: "needs_approval", approvalToken: approval.token, assistantText: `Approval required (${approval.token}) before executing this request.` };
    }

    try {
      const reached = reachedRateLimit(await this.options.subscriptionService.readRateLimits());
      const message = rateLimitMessage(reached);
      if (message) return { status: "failed", assistantText: message };
    } catch (error) {
      return { status: "failed", assistantText: `Unable to verify ChatGPT subscription limits before the turn: ${safeError(error)}` };
    }

    let selected: CodexModel | undefined;
    let fallbackFrom: string | undefined;
    try {
      const requested = request.modelSelection?.modelId ?? this.options.defaultModel;
      const models = await this.models();
      selected = models.find((model) => model.id === requested || model.model === requested) ?? models.find((model) => model.isDefault) ?? models[0];
      if (!selected) throw new Error("No visible models are available in the live Codex catalog");
      if (selected.id !== requested && selected.model !== requested) fallbackFrom = requested;
    } catch (error) {
      return { status: "failed", assistantText: `Unable to select an available ChatGPT model: ${safeError(error)}` };
    }

    const allTools = await discoverTools();
    const tools = applyToolAllowlist(allTools, profile?.toolAllowlist ?? ALFRED_AGENT.toolAllowlist);
    const state: ToolState = { artifacts: [], fetchedPages: [], researchSourceCards: [] };
    const context: ToolContext = {
      runId: request.runId, sessionId: request.sessionId, message: request.message, deadlineAtMs: Date.now() + maxDurationMs,
      policyMode, projectRoot: process.cwd(), runStore, searchManager: this.options.searchManager, workspaceDir: this.options.workspaceDir,
      defaults: { searchMaxResults: this.options.searchMaxResults, browseConcurrency: this.options.browseConcurrency }, state,
      browser: { pinchtabBaseUrl: this.options.pinchtabBaseUrl, enablePlaywright: this.options.enablePlaywright },
      isCancellationRequested: () => runStore.isCancellationRequested(request.runId), addArtifact: (path) => state.artifacts.push(path),
      setFetchedPages: (pages) => { state.fetchedPages = pages; }, getFetchedPages: () => state.fetchedPages,
      setResearchSourceCards: (cards) => { state.researchSourceCards = cards; }, getResearchSourceCards: () => state.researchSourceCards ?? [],
      scheduler: this.options.scheduler, provenance: request.provenance, schedulerControl: request.schedulerControl,
      llmProviders: [new CodexAppServerLlmProvider({ defaultModel: selected.id, clientFactory: this.options.clientFactory })]
    };
    await runStore.appendEvent({ runId: request.runId, sessionId: request.sessionId, phase: "route", eventType: "specialist_selected", payload: { specialist: ALFRED_AGENT.name, runtime: "codex_app_server", model: selected.id, toolCount: tools.size }, timestamp: nowIso() });

    const baseInstructions = [ALFRED_AGENT.systemPrompt, "All external effects must be performed only by calling an Alfred dynamic tool. Never use Codex shell, filesystem, patch, browser, network, MCP, or other built-in capabilities.", request.sessionContext?.conversationWindow?.length ? "" : request.sessionContext ? `Prior Alfred session context:\n${sessionContextText(request.sessionContext)}` : ""].filter(Boolean).join("\n\n");
    const controller = new AbortController();
    let toolCallCount = 0;
    let limitReached = false;
    const poll = setInterval(() => { void runStore.isCancellationRequested(request.runId).then((cancelled) => { if (cancelled) controller.abort("caller_cancellation"); }); }, 250);
    poll.unref?.();
    const textStream = new AssistantTextStream((assistantPreview) => runStore.updateRun(request.runId, { assistantPreview }));
    try {
      if (await runStore.isCancellationRequested(request.runId)) return { status: "cancelled" };
      const result = await runSafeAppServerTurn({
        model: selected.id, effort: request.modelSelection?.reasoningEffort ?? (selected.defaultReasoningEffort || undefined), baseInstructions, input: request.message,
        history: historyItems(request.sessionContext), dynamicTools: dynamicSpecs(tools), timeoutMs: maxDurationMs, signal: controller.signal,
        clientFactory: this.options.clientFactory,
        onNotification: (notification) => {
          if (notification.method === "item/agentMessage/delta" && isRecord(notification.params) && typeof notification.params.delta === "string") {
            textStream.append(notification.params.delta);
          }
        },
        onDynamicTool: async (call: DynamicToolCallParams) => {
          if (!call.callId || !call.threadId || !call.turnId || !call.tool || !isRecord(call.arguments) && typeof call.arguments !== "string") throw new Error("Malformed Alfred dynamic tool call");
          if (await runStore.isCancellationRequested(request.runId)) { controller.abort("caller_cancellation"); throw new Error("Alfred run cancellation requested"); }
          if (toolCallCount >= maxToolCalls) {
            limitReached = true; controller.abort("tool_call_limit");
            return { success: false, contentItems: [{ type: "inputText", text: "Rejected by Alfred: tool call limit exceeded" }] };
          }
          toolCallCount += 1;
          const envelope = await executeToolWithEnvelope({ toolName: call.tool, inputJson: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments), tools, context, runStore, runId: request.runId });
          return dynamicResponse(envelope);
        }
      });
      if (await runStore.isCancellationRequested(request.runId) || result.status === "interrupted" && !limitReached && controller.signal.reason === "caller_cancellation") return { status: "cancelled", artifactPaths: state.artifacts.length ? state.artifacts : undefined };
      if (result.status === "interrupted" && limitReached) return { status: "failed", assistantText: "The ChatGPT turn exceeded Alfred's tool-call limit.", artifactPaths: state.artifacts.length ? state.artifacts : undefined };
      if (result.status === "timeout") {
        if (schedulerTurn && request.schedulerControl && !request.schedulerControl.action) request.schedulerControl.reschedule(new Date(Date.now() + 60_000).toISOString(), "The scheduled ChatGPT turn timed out before completion.");
        return { status: schedulerTurn ? "completed" : "failed", assistantText: "The ChatGPT turn timed out before completing.", artifactPaths: state.artifacts.length ? state.artifacts : undefined };
      }
      if (result.status !== "completed") {
        const reachedAfterTurn = await this.options.subscriptionService.readRateLimits(true).then((snapshot) => rateLimitMessage(reachedRateLimit(snapshot))).catch(() => undefined);
        return { status: "failed", assistantText: reachedAfterTurn ?? `I encountered an error in the ChatGPT turn: ${result.error ?? "unknown App Server failure"}`, artifactPaths: state.artifacts.length ? state.artifacts : undefined };
      }
      if (result.usage) await runStore.addLlmUsage(request.runId, result.usage, 1);
      const notice = fallbackFrom ? `The configured model ${fallbackFrom} was unavailable; using ${selected.id} from the live catalog.` : "";
      return { status: "completed", assistantText: `${notice ? `${notice}\n\n` : ""}${result.content}`.trim(), artifactPaths: state.artifacts.length ? state.artifacts : undefined };
    } finally {
      clearInterval(poll);
      await textStream.close();
    }
  }
}
