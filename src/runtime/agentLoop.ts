import { z } from "zod";
import type { PolicyMode, RunOutcome, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { ToolDefaults, ToolState, ToolContext } from "../tools/types.js";
import { discoverTools, applyToolAllowlist, executeToolWithEnvelope } from "../tools/registry.js";
import { scrubToolOutput } from "../tools/outputScrubber.js";
import { getActiveLlmProvider } from "../provider/registry.js";
import type { LlmConversationMessage, LlmToolCallResult, LlmToolDef } from "../provider/types.js";
import type { SchedulerTaskApi } from "../scheduler/api.js";
import type { SchedulerProvenance } from "../scheduler/notifier.js";
import type { SchedulerTurnControl } from "../scheduler/api.js";
import type { TurnExecutionProfile } from "./executionProfile.js";

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
  enablePlaywright?: boolean;
  pinchtabBaseUrl?: string;
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  defaults: ToolDefaults;
  policyMode: PolicyMode;
  sessionContext?: SessionPromptContext;
  isCancellationRequested: () => Promise<boolean>;
  scheduler?: SchedulerTaskApi;
  provenance?: SchedulerProvenance;
  executionProfile?: TurnExecutionProfile;
  schedulerControl?: SchedulerTurnControl;
  maxToolCalls?: number;
}

const SCHEDULER_TERMINAL_ACTIONS = new Set([
  "scheduler_task_complete",
  "scheduler_task_reschedule"
]);
const SCHEDULER_FALLBACK_DELAY_SECONDS = 60;
const SCHEDULER_SUMMARY_MAX_CHARS = 500;

function isSchedulerTurn(options: AgentLoopOptions): boolean {
  return options.executionProfile?.origin === "scheduler" && Boolean(options.schedulerControl);
}

function clipSchedulerText(value: string | undefined, maxChars = SCHEDULER_SUMMARY_MAX_CHARS): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function schedulerTerminalOutcome(control: NonNullable<AgentLoopOptions["schedulerControl"]>, artifacts: string[]): RunOutcome {
  const action = control.action;
  if (!action) {
    return {
      status: "failed",
      assistantText: "The scheduled task did not select a terminal action.",
      artifactPaths: artifacts.length > 0 ? artifacts : undefined
    };
  }

  const detail = action.type === "complete" ? action.summary : action.reason;
  return {
    status: "completed",
    assistantText: action.type === "complete"
      ? `Scheduled task completed${detail ? `: ${detail}` : "."}`
      : `Scheduled task rescheduled${detail ? `: ${detail}` : "."}`,
    artifactPaths: artifacts.length > 0 ? artifacts : undefined
  };
}

async function forceSchedulerTerminalAction(
  options: AgentLoopOptions,
  state: ToolState,
  reason: string,
  progress?: string
): Promise<RunOutcome> {
  const control = options.schedulerControl;
  if (!control || control.action) {
    return control
      ? schedulerTerminalOutcome(control, state.artifacts)
      : {
          status: "failed",
          assistantText: "The scheduled task did not select a terminal action.",
          artifactPaths: state.artifacts.length > 0 ? state.artifacts : undefined
        };
  }

  const boundedProgress = clipSchedulerText(progress, 260);
  const explanation = clipSchedulerText(
    `${reason}${boundedProgress ? ` Partial result: ${boundedProgress}` : ""}`,
    SCHEDULER_SUMMARY_MAX_CHARS
  );
  control.reschedule(
    new Date(Date.now() + SCHEDULER_FALLBACK_DELAY_SECONDS * 1_000).toISOString(),
    explanation
  );
  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "final",
    eventType: "scheduler_terminal_action_forced",
    payload: {
      action: "reschedule",
      reason: "bounded_scheduler_turn",
      explanation
    },
    timestamp: nowIso()
  });

  return {
    status: "completed",
    assistantText: explanation,
    artifactPaths: state.artifacts.length > 0 ? state.artifacts : undefined
  };
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

/**
 * Build the provider-facing conversation for a turn.
 *
 * `conversationWindow` is the canonical representation of completed chat
 * history. When it exists, do not also inject summaries or recent-turn
 * snippets: those are lossy duplicates of the same exchange and can make an
 * older branch look newer than the final user message. The current request is
 * always represented exactly once, as the last message.
 */
export function buildInitialConversationMessages(
  systemPrompt: string,
  message: string,
  sessionContext?: SessionPromptContext
): LlmConversationMessage[] {
  const messages: LlmConversationMessage[] = [
    { role: "system", content: systemPrompt }
  ];
  const window = sessionContext?.conversationWindow ?? [];

  if (window.length > 0) {
    for (const entry of window) {
      messages.push({
        role: entry.role === "user" ? "user" : "assistant",
        content: entry.content
      });
    }
  } else if (sessionContext) {
    // Compatibility path for sessions created before conversationWindow was
    // introduced. Keep the fallback context separate from the current request
    // so it cannot be mistaken for the latest user instruction.
    const contextBlock = buildSessionContextBlock(sessionContext);
    if (contextBlock) {
      messages.push({
        role: "system",
        content: `Prior session context (background only; the final user message is authoritative):\n${contextBlock}`
      });
    }
  }

  messages.push({ role: "user", content: message });
  return messages;
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
    enablePlaywright,
    pinchtabBaseUrl,
    runStore,
    searchManager,
    workspaceDir,
    defaults,
    policyMode,
    sessionContext,
    isCancellationRequested,
    scheduler,
    provenance,
    schedulerControl,
    maxToolCalls
  } = options;

  const deadlineAtMs = Date.now() + maxDurationMs;
  const projectRoot = process.cwd();

  // Mutable agent state (shared across all tool executions in this run)
  const state: ToolState = {
    artifacts: [],
    fetchedPages: [],
    researchSourceCards: []
  };

  const provider = getActiveLlmProvider();

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
    llmProviders: [provider],
    browser: {
      pinchtabBaseUrl,
      enablePlaywright: enablePlaywright ?? false
    },
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
    getResearchSourceCards: () => state.researchSourceCards ?? [],
    scheduler,
    provenance,
    schedulerControl
  };

  // Discover and filter tools
  const allTools = await discoverTools();
  const tools = applyToolAllowlist(allTools, toolAllowlist);
  const llmTools = toolDefsToLlm(tools);

  const messages = buildInitialConversationMessages(systemPrompt, message, sessionContext);

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "thought",
    eventType: "agent_loop_started",
    payload: { model, toolCount: tools.size, maxIterations, toolAllowlist: toolAllowlist ?? "all" },
    timestamp: nowIso()
  });

  let iteration = 0;
  let toolCallCount = 0;
  let lastProgress: string | undefined;
  const schedulerTurn = isSchedulerTurn(options);
  const toolLimit = maxToolCalls ?? Number.MAX_SAFE_INTEGER;

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
      if (schedulerTurn) {
        return forceSchedulerTerminalAction(
          options,
          state,
          "The scheduled wake reached its time limit before selecting a terminal action.",
          lastProgress
        );
      }
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
    const requestController = new AbortController();
    let callerCancellationDetected = false;
    let deadlineAbort = false;
    let cancellationPollInFlight = false;
    const cancellationPoll = setInterval(() => {
      if (cancellationPollInFlight || requestController.signal.aborted) return;
      cancellationPollInFlight = true;
      void isCancellationRequested()
        .then((requested) => {
          if (requested) {
            callerCancellationDetected = true;
            requestController.abort("caller_cancellation");
          }
        })
        .finally(() => {
          cancellationPollInFlight = false;
        });
    }, 250);
    cancellationPoll.unref?.();

    const deadlineTimer = setTimeout(() => {
      deadlineAbort = true;
      requestController.abort("deadline");
    }, Math.max(1, remaining));
    deadlineTimer.unref?.();

    let llmResult: LlmToolCallResult;
    try {
      llmResult = await provider.generateWithTools({
        model,
        messages,
        tools: llmTools,
        timeoutMs: Math.max(1_000, Math.min(90_000, remaining - 5_000)),
        sessionId,
        signal: requestController.signal
      });
    } finally {
      clearInterval(cancellationPoll);
      clearTimeout(deadlineTimer);
    }

    if (llmResult.failureCode === "cancelled") {
      const callerCancelled = callerCancellationDetected || await isCancellationRequested();
      if (callerCancelled) {
        await runStore.appendEvent({
          runId,
          sessionId,
          phase: "final",
          eventType: "agent_loop_cancelled",
          payload: { iteration, reason: "caller_cancellation" },
          timestamp: nowIso()
        });
        return { status: "cancelled" };
      }
      if (deadlineAbort || Date.now() >= deadlineAtMs || llmResult.failureClass === "timeout") {
        await runStore.appendEvent({
          runId,
          sessionId,
          phase: "final",
          eventType: "agent_loop_timeout",
          payload: { iteration, reason: "deadline_abort" },
          timestamp: nowIso()
        });
        if (schedulerTurn) {
          return forceSchedulerTerminalAction(
            options,
            state,
            "The scheduled wake timed out before selecting a terminal action.",
            lastProgress
          );
        }
        return {
          status: "failed",
          assistantText: "The task timed out before completing. Please try again with a simpler request."
        };
      }
    }

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
      if (schedulerTurn) {
        return forceSchedulerTerminalAction(
          options,
          state,
          `The scheduled wake encountered ${llmResult.failureCode} before selecting a terminal action.`,
          llmResult.failureMessage ?? lastProgress
        );
      }
      return {
        status: "failed",
        assistantText: `I encountered an error while processing your request: ${llmResult.failureMessage ?? llmResult.failureCode}`
      };
    }

    if (llmResult.usage) {
      await runStore.addLlmUsage(runId, llmResult.usage, 1);
    }
    if (llmResult.providerMetadata) {
      await runStore.appendEvent({
        runId,
        sessionId,
        phase: "observe",
        eventType: "llm_provider_metadata",
        payload: { ...llmResult.providerMetadata },
        timestamp: nowIso()
      });
    }

    const finishReason = llmResult.finishReason;
    lastProgress = llmResult.content ?? lastProgress;

    // Model returned a final text response
    if (finishReason === "stop" || (!llmResult.toolCalls?.length && llmResult.content && finishReason !== "length")) {
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

      if (schedulerTurn) {
        return forceSchedulerTerminalAction(
          options,
          state,
          "The scheduled wake returned a response without selecting a terminal action.",
          assistantText || lastProgress
        );
      }

      return {
        status: "completed",
        assistantText: assistantText || "Task completed.",
        artifactPaths: state.artifacts.length > 0 ? state.artifacts : undefined
      };
    }

    // Model wants to call tools
    if (llmResult.toolCalls?.length) {
      // Append the assistant's tool-call message to history (unified format).
      // Provider state preserves opaque continuation data without exposing it
      // to tools, prompts, logs, or channel output.
      messages.push({
        role: "assistant",
        content: llmResult.content ?? null,
        toolCalls: llmResult.toolCalls,
        providerState: llmResult.providerState
      });

      // Execute each tool call and collect results
      for (const toolCall of llmResult.toolCalls) {
        const isTerminalAction = schedulerTurn && SCHEDULER_TERMINAL_ACTIONS.has(toolCall.name);
        // Reserve one call for the terminal action. This prevents a model from
        // consuming the entire budget on probes and then leaving no room to
        // complete or reschedule the cycle.
        if (schedulerTurn && !isTerminalAction && toolCallCount >= toolLimit - 1) {
          return forceSchedulerTerminalAction(
            options,
            state,
            "The scheduled wake exhausted its observation budget before selecting a terminal action.",
            lastProgress
          );
        }
        if (toolCallCount >= toolLimit) {
          if (schedulerTurn) {
            return forceSchedulerTerminalAction(
              options,
              state,
              "The scheduled wake reached its tool-call limit before selecting a terminal action.",
              lastProgress
            );
          }
          await runStore.appendEvent({
            runId,
            sessionId,
            phase: "final",
            eventType: "agent_loop_tool_limit",
            payload: { iteration, maxToolCalls, toolCallCount },
            timestamp: nowIso()
          });
          return { status: "failed", assistantText: "The scheduled task reached its tool-call limit." };
        }
        toolCallCount += 1;
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
          ? JSON.stringify(scrubToolOutput(envelope.result))
          : JSON.stringify({ error: envelope.error });
        lastProgress = resultContent;

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

        if (isTerminalAction && envelope.status === "ok" && schedulerControl?.action) {
          return schedulerTerminalOutcome(schedulerControl, state.artifacts);
        }
      }

      continue;
    }

    // Incomplete, refused, length-limited, or otherwise unexpected outcomes
    // are failures. Provider-specific details should already be mapped into
    // failureCode/failureMessage above.
    await runStore.appendEvent({
      runId,
      sessionId,
      phase: "final",
      eventType: "agent_loop_unexpected_finish",
      payload: { iteration, finishReason },
      timestamp: nowIso()
    });

    if (schedulerTurn) {
      return forceSchedulerTerminalAction(
        options,
        state,
        "The scheduled wake ended unexpectedly before selecting a terminal action.",
        lastProgress
      );
    }

    return {
      status: "failed",
      assistantText: finishReason === "length"
        ? "The model reached its output limit before completing the task."
        : "The model did not return a complete response.",
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

  if (schedulerTurn) {
    return forceSchedulerTerminalAction(
      options,
      state,
      "The scheduled wake exhausted its iteration budget before selecting a terminal action.",
      lastProgress
    );
  }

  return {
    status: "failed",
    assistantText: "I ran out of steps before completing the task. The task may be too complex — try breaking it into smaller parts."
  };
}
