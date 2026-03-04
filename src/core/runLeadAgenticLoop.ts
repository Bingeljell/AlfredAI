import { z } from "zod";
import type { RunOutcome, ToolCallRecord } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import { discoverLeadAgentTools } from "../agent/tools/registry.js";
import type { LeadAgentDefaults, LeadAgentState, LeadAgentToolContext } from "../agent/types.js";
import { parseRequestedLeadCount } from "../tools/lead/requestIntent.js";
import { runOpenAiChat, runOpenAiStructuredChatWithDiagnostics } from "../services/openAiClient.js";
import { LlmBudgetManager } from "../tools/lead/llmBudget.js";
import type { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import { writeLeadsCsv } from "../tools/csv/writeCsv.js";
import { redactValue } from "../utils/redact.js";

export type AgentStopReason =
  | "target_met"
  | "budget_exhausted"
  | "diminishing_returns"
  | "tool_blocked"
  | "manual_guardrail"
  | "manual_cancelled";

interface LeadAgentObservation {
  iteration: number;
  actionType: "single" | "parallel";
  toolNames: string[];
  newLeadCount: number;
  totalLeadCount: number;
  failedToolCount: number;
  note: string;
}

interface SingleAction {
  type: "single";
  tool: string;
  input: Record<string, unknown>;
}

interface ParallelAction {
  type: "parallel";
  tools: Array<{
    tool: string;
    input: Record<string, unknown>;
  }>;
}

type AgentAction = SingleAction | ParallelAction;

interface PlannerOutput {
  thought: string;
  actionType: "single" | "parallel" | "stop";
  singleAction: {
    tool: string;
    inputJson: string;
  } | null;
  parallelActions: Array<{
    tool: string;
    inputJson: string;
  }> | null;
  stopReason: AgentStopReason | null;
  stopExplanation: string | null;
}

const PlannerOutputSchema: z.ZodType<PlannerOutput> = z.object({
  thought: z.string().min(1).max(500),
  actionType: z.enum(["single", "parallel", "stop"]),
  singleAction: z
    .object({
      tool: z.string().min(1).max(80),
      inputJson: z.string().min(2).max(1200)
    })
    .nullable(),
  parallelActions: z
    .array(
      z.object({
        tool: z.string().min(1).max(80),
        inputJson: z.string().min(2).max(1200)
      })
    )
    .max(4)
    .nullable(),
  stopReason: z.enum(["target_met", "budget_exhausted", "diminishing_returns", "tool_blocked", "manual_guardrail", "manual_cancelled"]).nullable(),
  stopExplanation: z.string().max(320).nullable()
});

const PLANNER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    actionType: { type: "string", enum: ["single", "parallel", "stop"] },
    singleAction: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            tool: { type: "string", minLength: 1, maxLength: 80 },
            inputJson: { type: "string", minLength: 2, maxLength: 1200 }
          },
          required: ["tool", "inputJson"]
        },
        { type: "null" }
      ]
    },
    parallelActions: {
      anyOf: [
        {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              tool: { type: "string", minLength: 1, maxLength: 80 },
              inputJson: { type: "string", minLength: 2, maxLength: 1200 }
            },
            required: ["tool", "inputJson"]
          }
        },
        { type: "null" }
      ]
    },
    stopReason: {
      anyOf: [
        {
          type: "string",
          enum: ["target_met", "budget_exhausted", "diminishing_returns", "tool_blocked", "manual_guardrail", "manual_cancelled"]
        },
        { type: "null" }
      ]
    },
    stopExplanation: {
      anyOf: [{ type: "string", maxLength: 320 }, { type: "null" }]
    }
  },
  required: ["thought", "actionType", "singleAction", "parallelActions", "stopReason", "stopExplanation"]
} as const;

interface AgenticLoopOptions {
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  message: string;
  runId: string;
  sessionId: string;
  openAiApiKey?: string;
  defaults: LeadAgentDefaults;
  leadPipelineExecutor: typeof executeLeadSubReactPipeline;
  maxIterations: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxParallelTools: number;
  plannerMaxCalls: number;
  observationWindow: number;
  diminishingThreshold: number;
  isCancellationRequested: () => Promise<boolean>;
}

interface PlannerDecision {
  thought: string;
  action?: AgentAction;
  stop?: {
    reason: AgentStopReason;
    explanation: string;
  };
  usedFallback: boolean;
  plannerFailureReason?: string;
}

interface ToolRunResult {
  tool: string;
  status: "ok" | "error";
  durationMs: number;
  output?: Record<string, unknown>;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function leadKey(lead: { companyName: string; website?: string; sourceUrl: string }): string {
  if (lead.website) {
    try {
      return `domain:${new URL(lead.website).hostname.replace(/^www\./, "").toLowerCase()}`;
    } catch {
      // Fall through to company-name key.
    }
  }

  return `name:${normalizeCompanyName(lead.companyName)}`;
}

function summarizeToolResult(result: ToolRunResult): string {
  if (result.status === "error") {
    return `${result.tool} failed: ${result.error}`;
  }

  const output = result.output ?? {};
  if (result.tool === "recover_search") {
    const recovery = output.recovery as { recovered?: unknown; reason?: unknown } | undefined;
    const recovered = recovery?.recovered === true;
    const reason = typeof recovery?.reason === "string" ? recovery.reason : "unknown";
    return `recover_search ${recovered ? "recovered" : "not_recovered"} (${reason})`;
  }

  if (result.tool === "search_status") {
    const primaryHealthy = output.primaryHealthy === true ? "healthy" : "unhealthy";
    const fallbackHealthy = output.fallbackHealthy === true ? "healthy" : "unhealthy";
    return `search_status primary=${primaryHealthy}, fallback=${fallbackHealthy}`;
  }

  const leadCount = typeof output.totalLeadCount === "number" ? output.totalLeadCount : undefined;
  const added = typeof output.addedLeadCount === "number" ? output.addedLeadCount : undefined;
  if (typeof leadCount === "number") {
    const searchFailures = typeof output.searchFailureCount === "number" ? output.searchFailureCount : 0;
    const browseFailures = typeof output.browseFailureCount === "number" ? output.browseFailureCount : 0;
    const cancelled = output.cancelled === true;
    const cancelledText = cancelled ? ", cancelled=true" : "";
    const browseText = browseFailures > 0 ? `, browse failures ${browseFailures}` : "";
    if (searchFailures > 0) {
      return `${result.tool} ok, added ${added ?? 0}, total leads ${leadCount}, search failures ${searchFailures}${browseText}${cancelledText}`;
    }
    return `${result.tool} ok, added ${added ?? 0}, total leads ${leadCount}${browseText}${cancelledText}`;
  }

  if (typeof output.resultCount === "number") {
    return `${result.tool} ok, ${output.resultCount} results`;
  }

  return `${result.tool} ok`;
}

function computeDiminishingReturns(history: LeadAgentObservation[], threshold: number): boolean {
  if (history.length < 2) {
    return false;
  }

  const lastTwo = history.slice(-2);
  return lastTwo.every((item) => item.newLeadCount < threshold);
}

function highDeficitThreshold(requestedLeadCount: number): number {
  return Math.max(6, Math.ceil(requestedLeadCount * 0.35));
}

export function determineAdaptiveMinConfidence(
  iteration: number,
  requestedLeadCount: number,
  currentLeadCount: number
): number {
  if (iteration <= 1) {
    return 0.7;
  }

  if (iteration === 2) {
    return 0.65;
  }

  const deficit = Math.max(0, requestedLeadCount - currentLeadCount);
  return deficit >= highDeficitThreshold(requestedLeadCount) ? 0.6 : 0.65;
}

function applyLeadPipelineActionDefaults(
  input: Record<string, unknown>,
  iteration: number,
  requestedLeadCount: number,
  currentLeadCount: number
): Record<string, unknown> {
  if (typeof input.minConfidence === "number") {
    return input;
  }

  return {
    ...input,
    minConfidence: determineAdaptiveMinConfidence(iteration, requestedLeadCount, currentLeadCount)
  };
}

function fallbackPlan(iteration: number, defaults: LeadAgentDefaults, leadCount: number, targetLeadCount: number): PlannerDecision {
  if (leadCount >= targetLeadCount) {
    return {
      thought: "Target reached.",
      stop: { reason: "target_met", explanation: "Collected enough leads to satisfy requested target." },
      usedFallback: true
    };
  }

  if (iteration === 1) {
    return {
      thought: "Run baseline lead pipeline first.",
      action: {
        type: "single",
        tool: "lead_pipeline",
        input: { minConfidence: determineAdaptiveMinConfidence(iteration, targetLeadCount, leadCount) }
      },
      usedFallback: true
    };
  }

  if (iteration === 2) {
    return {
      thought: "Increase crawl depth to improve recall.",
      action: {
        type: "single",
        tool: "lead_pipeline",
        input: {
          maxPages: Math.min(20, defaults.subReactMaxPages + 5),
          minConfidence: determineAdaptiveMinConfidence(iteration, targetLeadCount, leadCount)
        }
      },
      usedFallback: true
    };
  }

  if (iteration === 3) {
    return {
      thought: "Persist current leads.",
      action: { type: "single", tool: "write_csv", input: {} },
      usedFallback: true
    };
  }

  return {
    thought: "Fallback planner completed baseline/deeper passes.",
    stop: {
      reason: "diminishing_returns",
      explanation: "Fallback planner stopped after baseline, deep pass, and persistence checkpoint."
    },
    usedFallback: true
  };
}

function parseToolInputJson(inputJson: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizePlannerAction(output: PlannerOutput, maxParallelTools: number): AgentAction | undefined {
  if (output.actionType === "single") {
    if (!output.singleAction) {
      return undefined;
    }
    const input = parseToolInputJson(output.singleAction.inputJson);
    if (!input) {
      return undefined;
    }
    return {
      type: "single",
      tool: output.singleAction.tool,
      input
    };
  }

  if (output.actionType === "parallel") {
    const tools = (output.parallelActions ?? [])
      .slice(0, Math.max(1, maxParallelTools))
      .flatMap((item) => {
        const input = parseToolInputJson(item.inputJson);
        if (!input) {
          return [];
        }
        return [{ tool: item.tool, input }];
      });
    if (tools.length === 0) {
      return undefined;
    }
    return {
      type: "parallel",
      tools
    };
  }

  return undefined;
}

async function decidePlannerAction(
  options: AgenticLoopOptions,
  plannerBudget: LlmBudgetManager,
  availableTools: Array<{ name: string; description: string; inputHint: string }>,
  iteration: number,
  state: LeadAgentState,
  observations: LeadAgentObservation[]
): Promise<PlannerDecision> {
  if (!options.openAiApiKey || !plannerBudget.consume()) {
    return fallbackPlan(iteration, options.defaults, state.leads.length, state.requestedLeadCount);
  }

  const lastObservations = observations.slice(-options.observationWindow);
  const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
    {
      apiKey: options.openAiApiKey,
      schemaName: "lead_agent_plan",
      jsonSchema: PLANNER_OUTPUT_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content:
            "You are Alfred's lead-generation planner. Decide the next best tool action (single or parallel) to reach lead targets. Prefer actions that improve yield and avoid unnecessary calls. If observations indicate search failures/provider outage, first use search_status, then recover_search when recovery is supported, then retry search or lead_pipeline. Treat service recovery as agentic work you should attempt before stopping. Respect tool constraints: lead_pipeline.maxPages <= 25, browseConcurrency <= 6, extractionBatchSize <= 6, llmMaxCalls <= 20, minConfidence between 0 and 1. For action inputs, always return inputJson as a valid JSON object string (for example: \"{}\" or \"{\\\"maxPages\\\":20}\")."
        },
        {
          role: "user",
          content: JSON.stringify({
            request: options.message,
            iteration,
            leadState: {
              targetLeadCount: state.requestedLeadCount,
              currentLeadCount: state.leads.length,
              artifactCount: state.artifacts.length
            },
            tools: availableTools,
            recentObservations: lastObservations
          })
        }
      ]
    },
    PlannerOutputSchema
  );

  if (!diagnostic.result) {
    return {
      ...fallbackPlan(iteration, options.defaults, state.leads.length, state.requestedLeadCount),
      plannerFailureReason: diagnostic.failureMessage
    };
  }

  if (diagnostic.result.actionType === "stop") {
    return {
      thought: diagnostic.result.thought,
      stop: {
        reason: diagnostic.result.stopReason ?? "manual_guardrail",
        explanation: diagnostic.result.stopExplanation ?? "Planner requested stop"
      },
      usedFallback: false
    };
  }

  const action = normalizePlannerAction(diagnostic.result, options.maxParallelTools);
  if (!action) {
    return {
      ...fallbackPlan(iteration, options.defaults, state.leads.length, state.requestedLeadCount),
      plannerFailureReason: "planner_returned_empty_action"
    };
  }

  return {
    thought: diagnostic.result.thought,
    action,
    usedFallback: false
  };
}

async function recordToolCall(runStore: RunStore, runId: string, call: Omit<ToolCallRecord, "timestamp">): Promise<void> {
  await runStore.addToolCall(runId, {
    ...call,
    timestamp: nowIso()
  });
}

export async function runLeadAgenticLoop(options: AgenticLoopOptions): Promise<RunOutcome> {
  const availableTools = await discoverLeadAgentTools();
  const targetLeadCount = parseRequestedLeadCount(options.message);
  const state: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: targetLeadCount
  };

  const addLeads: LeadAgentToolContext["addLeads"] = (incoming) => {
    let addedCount = 0;
    const map = new Map<string, (typeof incoming)[number]>();

    for (const lead of state.leads) {
      map.set(leadKey(lead), lead);
    }

    for (const lead of incoming) {
      const key = leadKey(lead);
      const current = map.get(key);
      if (!current) {
        map.set(key, lead);
        addedCount += 1;
        continue;
      }
      if (lead.confidence > current.confidence) {
        map.set(key, lead);
      }
    }

    state.leads = Array.from(map.values());
    return {
      addedCount,
      totalCount: state.leads.length
    };
  };

  const addArtifact: LeadAgentToolContext["addArtifact"] = (artifactPath) => {
    if (!state.artifacts.includes(artifactPath)) {
      state.artifacts.push(artifactPath);
    }
  };

  const toolContext: LeadAgentToolContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    message: options.message,
    runStore: options.runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    openAiApiKey: options.openAiApiKey,
    defaults: options.defaults,
    leadPipelineExecutor: options.leadPipelineExecutor,
    state,
    isCancellationRequested: options.isCancellationRequested,
    addLeads,
    addArtifact
  };

  const startMs = Date.now();
  const plannerBudget = new LlmBudgetManager(options.plannerMaxCalls);
  const observations: LeadAgentObservation[] = [];
  let toolCallsUsed = 0;
  let stop: { reason: AgentStopReason; explanation: string } | undefined;
  let diminishingObservedOnce = false;

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "agent_loop_started",
    payload: {
      maxIterations: options.maxIterations,
      maxDurationMs: options.maxDurationMs,
      maxToolCalls: options.maxToolCalls
    },
    timestamp: nowIso()
  });

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    if (await options.isCancellationRequested()) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "cancel_acknowledged",
        payload: {
          iteration,
          stage: "pre_plan"
        },
        timestamp: nowIso()
      });
      stop = {
        reason: "manual_cancelled",
        explanation: "Run cancelled by user request."
      };
      break;
    }

    const elapsedMs = Date.now() - startMs;
    if (elapsedMs > options.maxDurationMs) {
      stop = {
        reason: "budget_exhausted",
        explanation: `Stopped after exceeding max duration (${options.maxDurationMs}ms).`
      };
      break;
    }

    if (toolCallsUsed >= options.maxToolCalls) {
      stop = {
        reason: "budget_exhausted",
        explanation: `Stopped after reaching tool-call budget (${options.maxToolCalls}).`
      };
      break;
    }

    const plannerDecision = await decidePlannerAction(
      options,
      plannerBudget,
      Array.from(availableTools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputHint: tool.inputHint
      })),
      iteration,
      state,
      observations
    );

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "agent_plan_created",
      payload: {
        iteration,
        thought: plannerDecision.thought,
        action: plannerDecision.action,
        stop: plannerDecision.stop,
        usedFallback: plannerDecision.usedFallback,
        plannerFailureReason: plannerDecision.plannerFailureReason,
        plannerCallsUsed: plannerBudget.used,
        plannerCallsRemaining: plannerBudget.remaining
      },
      timestamp: nowIso()
    });

    if (plannerDecision.stop) {
      stop = plannerDecision.stop;
      break;
    }

    const action = plannerDecision.action;
    if (!action) {
      stop = {
        reason: "tool_blocked",
        explanation: "Planner did not provide a runnable action."
      };
      break;
    }

    const baseCalls = action.type === "single" ? [{ tool: action.tool, input: action.input }] : action.tools;
    const calls = baseCalls.map((call) => {
      if (call.tool !== "lead_pipeline") {
        return call;
      }
      return {
        ...call,
        input: applyLeadPipelineActionDefaults(call.input, iteration, state.requestedLeadCount, state.leads.length)
      };
    });
    if (calls.length === 0) {
      stop = {
        reason: "tool_blocked",
        explanation: "No tool calls selected for action."
      };
      break;
    }

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "tool",
      eventType: "agent_action_selected",
      payload: {
        iteration,
        actionType: action.type,
        calls
      },
      timestamp: nowIso()
    });

    const leadsBefore = state.leads.length;
    const callExecutions = calls.map(async (call) => {
      const tool = availableTools.get(call.tool);
      if (!tool) {
        const errorMessage = `Tool not found: ${call.tool}`;
        await recordToolCall(options.runStore, options.runId, {
          toolName: call.tool,
          inputRedacted: redactValue(call.input),
          outputRedacted: { error: errorMessage },
          durationMs: 0,
          status: "error"
        });
        return {
          tool: call.tool,
          status: "error",
          durationMs: 0,
          error: errorMessage
        } as ToolRunResult;
      }

      const parsedInput = tool.inputSchema.safeParse(call.input);
      if (!parsedInput.success) {
        const errorMessage = parsedInput.error.message.slice(0, 240);
        await recordToolCall(options.runStore, options.runId, {
          toolName: call.tool,
          inputRedacted: redactValue(call.input),
          outputRedacted: { error: errorMessage },
          durationMs: 0,
          status: "error"
        });
        return {
          tool: call.tool,
          status: "error",
          durationMs: 0,
          error: errorMessage
        } as ToolRunResult;
      }

      const started = Date.now();
      try {
        const output = await tool.execute(parsedInput.data, toolContext);
        const durationMs = Date.now() - started;
        await recordToolCall(options.runStore, options.runId, {
          toolName: call.tool,
          inputRedacted: redactValue(parsedInput.data),
          outputRedacted: redactValue(output),
          durationMs,
          status: "ok"
        });

        return {
          tool: call.tool,
          status: "ok",
          durationMs,
          output
        } as ToolRunResult;
      } catch (error) {
        const durationMs = Date.now() - started;
        const errorMessage = error instanceof Error ? error.message.slice(0, 240) : "Unknown tool error";
        await recordToolCall(options.runStore, options.runId, {
          toolName: call.tool,
          inputRedacted: redactValue(parsedInput.data),
          outputRedacted: { error: errorMessage },
          durationMs,
          status: "error"
        });

        return {
          tool: call.tool,
          status: "error",
          durationMs,
          error: errorMessage
        } as ToolRunResult;
      }
    });

    const results = action.type === "parallel" ? await Promise.all(callExecutions) : [await callExecutions[0]!];
    toolCallsUsed += calls.length;

    const newLeadCount = state.leads.length - leadsBefore;
    const failedToolCount = results.filter((result) => result.status === "error").length;

    const observation: LeadAgentObservation = {
      iteration,
      actionType: action.type,
      toolNames: calls.map((item) => item.tool),
      newLeadCount,
      totalLeadCount: state.leads.length,
      failedToolCount,
      note: results.map(summarizeToolResult).join(" | ")
    };
    observations.push(observation);

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "observe",
      eventType: "agent_action_result",
      payload: {
        iteration,
        actionType: action.type,
        newLeadCount,
        totalLeadCount: state.leads.length,
        failedToolCount,
        results
      },
      timestamp: nowIso()
    });

    const actionCancelled = results.some((result) => result.output?.cancelled === true);
    if (actionCancelled || (await options.isCancellationRequested())) {
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "cancel_acknowledged",
        payload: {
          iteration,
          stage: actionCancelled ? "tool_execution" : "post_action"
        },
        timestamp: nowIso()
      });
      stop = {
        reason: "manual_cancelled",
        explanation: "Run cancelled by user request."
      };
      break;
    }

    if (state.leads.length >= state.requestedLeadCount) {
      stop = {
        reason: "target_met",
        explanation: `Reached target with ${state.leads.length} leads.`
      };
      break;
    }

    if (computeDiminishingReturns(observations, options.diminishingThreshold)) {
      if (diminishingObservedOnce) {
        stop = {
          reason: "diminishing_returns",
          explanation: `Last two iterations added fewer than ${options.diminishingThreshold} leads each.`
        };
        break;
      }

      diminishingObservedOnce = true;
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "agent_replan",
        payload: {
          iteration,
          reason: "diminishing_returns",
          explanation: "Yield is low; forcing one replan iteration before stopping."
        },
        timestamp: nowIso()
      });
    }
  }

  if (!stop) {
    stop = {
      reason: "budget_exhausted",
      explanation: `Reached iteration budget (${options.maxIterations}).`
    };
  }

  let csvPath = state.artifacts.find((item) => item.endsWith("/leads.csv"));
  if (!csvPath) {
    const start = Date.now();
    csvPath = await writeLeadsCsv(options.workspaceDir, options.runId, state.leads);
    addArtifact(csvPath);
    await recordToolCall(options.runStore, options.runId, {
      toolName: "write_csv",
      inputRedacted: { candidateCount: state.leads.length },
      outputRedacted: { csvPath },
      durationMs: Date.now() - start,
      status: "ok"
    });
  }

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "persist",
    eventType: "artifact_written",
    payload: {
      csvPath,
      candidateCount: state.leads.length,
      totalToolCalls: toolCallsUsed,
      plannerCallsUsed: plannerBudget.used
    },
    timestamp: nowIso()
  });

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "final",
    eventType: "agent_stop",
    payload: {
      reason: stop.reason,
      explanation: stop.explanation,
      iterationCount: observations.length,
      leadCount: state.leads.length,
      requestedLeadCount: state.requestedLeadCount,
      totalToolCalls: toolCallsUsed,
      plannerCallsUsed: plannerBudget.used,
      elapsedMs: Date.now() - startMs
    },
    timestamp: nowIso()
  });

  let llmSummary: string | undefined;
  if (options.openAiApiKey) {
    try {
      llmSummary = await runOpenAiChat({
        apiKey: options.openAiApiKey,
        messages: [
          {
            role: "system",
            content: "Summarize lead-agent outcome in 4 concise bullets with stop reason and remaining gap."
          },
          {
            role: "user",
            content: JSON.stringify(
              redactValue({
                requestMessage: options.message,
                stop,
                requestedLeadCount: state.requestedLeadCount,
                finalLeadCount: state.leads.length,
                observations: observations.slice(-6),
                candidatePreview: state.leads.slice(0, 5)
              })
            )
          }
        ]
      });
    } catch {
      llmSummary = undefined;
    }
  }

  const deficitCount = Math.max(0, state.requestedLeadCount - state.leads.length);
  const assistantText =
    llmSummary ??
    [
      `Lead agent completed with ${state.leads.length} validated leads.`,
      `Stop reason: ${stop.reason}. ${stop.explanation}`,
      `Tool calls used: ${toolCallsUsed}/${options.maxToolCalls}; planner calls: ${plannerBudget.used}/${options.plannerMaxCalls}.`,
      `Requested ${state.requestedLeadCount}, deficit ${deficitCount}.`
    ].join("\n");

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "final",
    eventType: "final_answer",
    payload: {
      candidateCount: state.leads.length,
      requestedLeadCount: state.requestedLeadCount,
      deficitCount,
      csvPath,
      stopReason: stop.reason,
      totalToolCalls: toolCallsUsed,
      plannerCallsUsed: plannerBudget.used
    },
    timestamp: nowIso()
  });

  return {
    status: stop.reason === "manual_cancelled" ? "cancelled" : "completed",
    assistantText,
    artifactPaths: [csvPath]
  };
}
