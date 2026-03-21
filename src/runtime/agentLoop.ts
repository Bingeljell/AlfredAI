import { z } from "zod";
import type { PolicyMode, RunOutcome, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { ToolDefaults, ToolState, ToolContext } from "../tools/types.js";
import { discoverTools, applyToolAllowlist, executeToolWithEnvelope } from "../tools/registry.js";
import { getActiveLlmProvider } from "../provider/registry.js";
import type { LlmConversationMessage, LlmToolDef } from "../provider/types.js";

export interface AgentLoopOptions {
  runId: string;
  sessionId: string;
  message: string;
  model: string;
  systemPrompt: string;
  toolAllowlist?: string[];
  maxIterations: number;
  maxDurationMs: number;
  openAiApiKey?: string;
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  defaults: ToolDefaults;
  policyMode: PolicyMode;
  sessionContext?: SessionPromptContext;
  isCancellationRequested: () => Promise<boolean>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toolDefsToLlm(tools: Map<string, { name: string; description: string; inputSchema: z.ZodTypeAny }>): LlmToolDef[] {
  return Array.from(tools.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>
  }));
}

function buildSessionContextBlock(ctx: SessionPromptContext): string {
  const parts: string[] = [];
  if (ctx.activeObjective) {
    parts.push(`Active objective: ${ctx.activeObjective}`);
  }
  if (ctx.sessionSummary) {
    parts.push(`Session context: ${ctx.sessionSummary}`);
  }
  if (ctx.recentTurns && ctx.recentTurns.length > 0) {
    const snippets = ctx.recentTurns
      .slice(-3)
      .map((t) => `- ${t.role}: ${String(t.content ?? "").slice(0, 200)}`)
      .join("\n");
    parts.push(`Recent turns:\n${snippets}`);
  }
  return parts.join("\n\n");
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<RunOutcome> {
  const {
    runId,
    sessionId,
    message,
    model,
    systemPrompt,
    toolAllowlist,
    maxIterations,
    maxDurationMs,
    openAiApiKey,
    runStore,
    searchManager,
    workspaceDir,
    defaults,
    policyMode,
    sessionContext,
    isCancellationRequested
  } = options;

  const deadlineAtMs = Date.now() + maxDurationMs;
  const projectRoot = process.cwd();

  // Mutable agent state (shared across all tool executions in this run)
  const state: ToolState = {
    artifacts: [],
    fetchedPages: [],
    researchSourceCards: []
  };

  const context: ToolContext = {
    runId,
    sessionId,
    message,
    deadlineAtMs,
    policyMode,
    projectRoot,
    runStore,
    searchManager,
    workspaceDir,
    openAiApiKey,
    defaults,
    state,
    isCancellationRequested,
    addArtifact: (artifactPath) => {
      state.artifacts.push(artifactPath);
    },
    setFetchedPages: (pages) => {
      state.fetchedPages = pages;
    },
    getFetchedPages: () => state.fetchedPages,
    setResearchSourceCards: (cards) => {
      state.researchSourceCards = cards;
    },
    getResearchSourceCards: () => state.researchSourceCards ?? []
  };

  // Discover and filter tools
  const allTools = await discoverTools();
  const tools = applyToolAllowlist(allTools, toolAllowlist);
  const llmTools = toolDefsToLlm(tools);
  const provider = getActiveLlmProvider();

  // Build initial conversation — inject sliding window as proper message pairs
  // so Gemini's implicit caching benefits from the stable conversation prefix.
  const contextBlock = sessionContext ? buildSessionContextBlock(sessionContext) : "";
  const window = sessionContext?.conversationWindow ?? [];

  const messages: LlmConversationMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  if (window.length > 0) {
    // Prepend the context summary to the first user entry in the window,
    // then replay all window turns as real messages before the current one.
    for (let i = 0; i < window.length; i++) {
      const entry = window[i]!;
      const role = entry.role === "user" ? "user" as const : "assistant" as const;
      if (i === 0 && contextBlock && entry.role === "user") {
        messages.push({ role: "user", content: `${contextBlock}\n\n---\n\n${entry.content}` });
      } else {
        messages.push({ role, content: entry.content });
      }
    }
    messages.push({ role: "user", content: message });
  } else {
    // No window yet — existing behaviour: prepend context to the current message.
    const userContent = contextBlock ? `${contextBlock}\n\n---\n\n${message}` : message;
    messages.push({ role: "user", content: userContent });
  }

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "thought",
    eventType: "agent_loop_started",
    payload: { model, toolCount: tools.size, maxIterations, toolAllowlist: toolAllowlist ?? "all" },
    timestamp: nowIso()
  });

  let iteration = 0;

  while (iteration < maxIterations) {
    iteration += 1;

    // Check deadline
    if (Date.now() >= deadlineAtMs) {
      await runStore.appendEvent({
        runId,
        sessionId,
        phase: "final",
        eventType: "agent_loop_timeout",
        payload: { iteration, maxIterations, artifactCount: state.artifacts.length },
        timestamp: nowIso()
      });
      // If work was completed before the deadline hit, surface it rather than reporting failure
      if (state.artifacts.length > 0) {
        return {
          status: "completed",
          assistantText: `Completed the core task but ran out of time to send a full summary. Results saved to: ${state.artifacts.join(", ")}`,
          artifactPaths: state.artifacts
        };
      }
      return {
        status: "failed",
        assistantText: "The task timed out before completing. Please try again with a simpler request."
      };
    }

    // Check cancellation
    if (await isCancellationRequested()) {
      return { status: "cancelled" };
    }

    await runStore.appendEvent({
      runId,
      sessionId,
      phase: "thought",
      eventType: "agent_loop_iteration",
      payload: { iteration, maxIterations, messageCount: messages.length },
      timestamp: nowIso()
    });

    const remaining = deadlineAtMs - Date.now();
    const llmResult = await provider.generateWithTools({
      model,
      messages,
      tools: llmTools,
      timeoutMs: Math.min(90_000, remaining - 5_000)
    });

    if (llmResult.failureCode) {
      await runStore.appendEvent({
        runId,
        sessionId,
        phase: "final",
        eventType: "agent_loop_llm_failure",
        payload: {
          iteration,
          failureCode: llmResult.failureCode,
          failureMessage: llmResult.failureMessage,
          statusCode: llmResult.statusCode
        },
        timestamp: nowIso()
      });
      return {
        status: "failed",
        assistantText: `I encountered an error while processing your request: ${llmResult.failureMessage ?? llmResult.failureCode}`
      };
    }

    if (llmResult.usage) {
      await runStore.addLlmUsage(runId, llmResult.usage, 1);
    }

    const finishReason = llmResult.finishReason;

    // Model returned a final text response
    if (finishReason === "stop" || (!llmResult.toolCalls?.length && llmResult.content)) {
      const assistantText = llmResult.content ?? "";

      await runStore.appendEvent({
        runId,
        sessionId,
        phase: "final",
        eventType: "agent_loop_complete",
        payload: {
          iteration,
          finishReason,
          responseLength: assistantText.length,
          artifactCount: state.artifacts.length
        },
        timestamp: nowIso()
      });

      return {
        status: "completed",
        assistantText: assistantText || "Task completed.",
        artifactPaths: state.artifacts.length > 0 ? state.artifacts : undefined
      };
    }

    // Model wants to call tools
    if (llmResult.toolCalls?.length) {
      // Append the assistant's tool-call message to history (unified format).
      // _rawGeminiParts preserves thought_signature for thinking models.
      messages.push({
        role: "assistant",
        content: llmResult.content ?? null,
        toolCalls: llmResult.toolCalls,
        _rawGeminiParts: llmResult.rawAssistantParts
      });

      // Execute each tool call and collect results
      for (const toolCall of llmResult.toolCalls) {
        const toolName = toolCall.name;
        const inputJson = toolCall.arguments;

        await runStore.appendEvent({
          runId,
          sessionId,
          phase: "tool",
          eventType: "tool_call_dispatched",
          payload: { toolName, toolCallId: toolCall.id, iteration },
          timestamp: nowIso()
        });

        const envelope = await executeToolWithEnvelope({
          toolName,
          inputJson,
          tools,
          context,
          runStore,
          runId
        });

        const resultContent = envelope.status === "ok"
          ? JSON.stringify(envelope.result)
          : JSON.stringify({ error: envelope.error });

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          toolName,
          content: resultContent
        });

        await runStore.appendEvent({
          runId,
          sessionId,
          phase: "tool",
          eventType: "tool_call_result",
          payload: {
            toolName,
            toolCallId: toolCall.id,
            iteration,
            status: envelope.status,
            durationMs: envelope.durationMs
          },
          timestamp: nowIso()
        });
      }

      continue;
    }

    // Unexpected finish reason — treat as done
    await runStore.appendEvent({
      runId,
      sessionId,
      phase: "final",
      eventType: "agent_loop_unexpected_finish",
      payload: { iteration, finishReason, content: llmResult.content?.slice(0, 200) },
      timestamp: nowIso()
    });

    return {
      status: "completed",
      assistantText: llmResult.content ?? "Task completed.",
      artifactPaths: state.artifacts.length > 0 ? state.artifacts : undefined
    };
  }

  // Exhausted max iterations
  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "final",
    eventType: "agent_loop_iterations_exhausted",
    payload: { iteration, maxIterations },
    timestamp: nowIso()
  });

  return {
    status: "failed",
    assistantText: "I ran out of steps before completing the task. The task may be too complex — try breaking it into smaller parts."
  };
}
