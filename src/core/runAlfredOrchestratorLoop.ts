import { z } from "zod";
import type { PolicyMode, RunOutcome } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import * as openAiClient from "../services/openAiClient.js";
import { composeSystemPrompt } from "../prompts/composePrompt.js";
import { ALFRED_MASTER_PROMPT_VERSION, ALFRED_MASTER_SYSTEM_PROMPT } from "../prompts/master/alfred.system.js";
import type { LeadAgentRuntimeOptions } from "./runLeadAgenticLoop.js";
import { runAgentLoop } from "./runAgentLoop.js";
import { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import type { LeadAgentDefaults, LeadAgentState, LeadAgentToolContext } from "../agent/types.js";
import { applyToolAllowlist, discoverLeadAgentTools } from "../agent/tools/registry.js";
import { resolveLeadAgentToolAllowlist } from "../agent/toolPolicies.js";
import { redactValue } from "../utils/redact.js";
import { listAgentSkills } from "../agent/skills/registry.js";

interface AlfredOrchestratorOptions {
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
  policyMode: PolicyMode;
  isCancellationRequested: () => Promise<boolean>;
  structuredChatRunner?: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
  agentLoopRunner?: typeof runAgentLoop;
}

interface AlfredPlannerOutput {
  thought: string;
  actionType: "delegate_agent" | "call_tool" | "respond";
  delegateAgent: string | null;
  delegateBrief: string | null;
  toolName: string | null;
  toolInputJson: string | null;
  responseText: string | null;
}

interface AlfredCompletionEvaluation {
  thought: string;
  shouldRespond: boolean;
  responseText: string | null;
  continueReason: string | null;
  confidence: number;
}

const ALFRED_PLANNER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    actionType: { type: "string", enum: ["delegate_agent", "call_tool", "respond"] },
    delegateAgent: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    delegateBrief: { anyOf: [{ type: "string", minLength: 1, maxLength: 1200 }, { type: "null" }] },
    toolName: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    toolInputJson: { anyOf: [{ type: "string", minLength: 2, maxLength: 1200 }, { type: "null" }] },
    responseText: { anyOf: [{ type: "string", minLength: 1, maxLength: 4000 }, { type: "null" }] }
  },
  required: ["thought", "actionType", "delegateAgent", "delegateBrief", "toolName", "toolInputJson", "responseText"]
} as const;

const AlfredPlannerOutputSchema: z.ZodType<AlfredPlannerOutput> = z.object({
  thought: z.string().min(1).max(500),
  actionType: z.enum(["delegate_agent", "call_tool", "respond"]),
  delegateAgent: z.string().min(1).max(80).nullable(),
  delegateBrief: z.string().min(1).max(1200).nullable(),
  toolName: z.string().min(1).max(80).nullable(),
  toolInputJson: z.string().min(2).max(1200).nullable(),
  responseText: z.string().min(1).max(4000).nullable()
});

const ALFRED_COMPLETION_EVALUATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 500 },
    shouldRespond: { type: "boolean" },
    responseText: { anyOf: [{ type: "string", minLength: 1, maxLength: 4000 }, { type: "null" }] },
    continueReason: { anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["thought", "shouldRespond", "responseText", "continueReason", "confidence"]
} as const;

const AlfredCompletionEvaluationSchema: z.ZodType<AlfredCompletionEvaluation> = z.object({
  thought: z.string().min(1).max(500),
  shouldRespond: z.boolean(),
  responseText: z.string().min(1).max(4000).nullable(),
  continueReason: z.string().min(1).max(500).nullable(),
  confidence: z.number().min(0).max(1)
});

function nowIso(): string {
  return new Date().toISOString();
}

function parseToolInputJson(inputJson: string | null): Record<string, unknown> | undefined {
  if (!inputJson) {
    return undefined;
  }
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

function buildAlfredPlannerSystemPrompt(): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Role",
      content:
        "You are Alfred, the master orchestrator. Decide whether to delegate to a specialist agent, call a tool directly, or respond. Focus on the current turn objective only."
    },
    {
      label: "Directives",
      content:
        "Treat this as the active task for this turn. Sessions can persist, but success criteria are based on the current turn unless user explicitly references prior work. Prefer delegating lead-generation execution to lead_agent. Use call_tool for lightweight diagnostics or direct retrieval when that is higher-value than full delegation. After receiving specialist output, evaluate against the turn objective and either respond or re-delegate with a refined brief. Keep decisions prompt-driven; deterministic behavior should be limited to budget/safety guardrails."
    }
  ]);
}

function buildAlfredCompletionEvaluatorSystemPrompt(): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Role",
      content:
        "You are Alfred's completion evaluator. Decide whether the latest successful action already provides enough evidence to answer the current user turn."
    },
    {
      label: "Directives",
      content:
        "Respond `shouldRespond=true` only when the latest successful tool or delegated agent result is sufficient to answer the current turn with reasonable honesty. If the result is partial, missing key evidence, or needs another action, set `shouldRespond=false` and explain exactly what is still missing. Keep this prompt-driven; do not invent facts beyond the observed result."
    }
  ]);
}

function truncateForPrompt(value: unknown, maxLength = 2400): string {
  const serialized =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, nestedValue) => {
          if (typeof nestedValue === "string" && nestedValue.length > 400) {
            return `${nestedValue.slice(0, 400)}...`;
          }
          return nestedValue;
        });
  return serialized.slice(0, maxLength);
}

async function runCompletionEvaluator(args: {
  apiKey?: string;
  structuredChatRunner: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
  message: string;
  iteration: number;
  remainingMs: number;
  recentObservations: Array<{ iteration: number; summary: string; outcome: string }>;
  lastDelegationSummary: string;
  actionSummary: string;
  latestResult: unknown;
}): Promise<openAiClient.StructuredChatDiagnostic<AlfredCompletionEvaluation>> {
  return args.structuredChatRunner(
    {
      apiKey: args.apiKey,
      schemaName: "alfred_completion_evaluation",
      jsonSchema: ALFRED_COMPLETION_EVALUATION_JSON_SCHEMA,
      messages: [
        {
          role: "system",
          content: buildAlfredCompletionEvaluatorSystemPrompt()
        },
        {
          role: "user",
          content: JSON.stringify({
            turnObjective: args.message,
            iteration: args.iteration,
            remainingMs: args.remainingMs,
            actionSummary: args.actionSummary,
            lastDelegationSummary: args.lastDelegationSummary,
            recentObservations: args.recentObservations.slice(-5),
            latestResult: truncateForPrompt(args.latestResult, 2600)
          })
        }
      ]
    },
    AlfredCompletionEvaluationSchema
  );
}

export async function runAlfredOrchestratorLoop(options: AlfredOrchestratorOptions): Promise<RunOutcome> {
  const startMs = Date.now();
  const deadlineAtMs = startMs + options.maxDurationMs;
  const leadAgentAllowlist = resolveLeadAgentToolAllowlist();
  const discoveredTools = await discoverLeadAgentTools();
  const availableTools = applyToolAllowlist(discoveredTools, leadAgentAllowlist);
  const availableToolSpecs = Array.from(availableTools.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputHint: tool.inputHint
  }));
  const availableAgents = listAgentSkills().map((skill) => ({
    name: skill.name,
    description: skill.description
  }));

  const alfredState: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: 0,
    fetchedPages: []
  };
  const addLeads: LeadAgentToolContext["addLeads"] = (incoming) => {
    let addedCount = 0;
    for (const lead of incoming) {
      const existingIndex = alfredState.leads.findIndex((item) => item.sourceUrl === lead.sourceUrl && item.companyName === lead.companyName);
      if (existingIndex >= 0) {
        if (lead.confidence > (alfredState.leads[existingIndex]?.confidence ?? 0)) {
          alfredState.leads[existingIndex] = lead;
        }
      } else {
        alfredState.leads.push(lead);
        addedCount += 1;
      }
    }
    return { addedCount, totalCount: alfredState.leads.length };
  };
  const addArtifact: LeadAgentToolContext["addArtifact"] = (artifactPath) => {
    if (!alfredState.artifacts.includes(artifactPath)) {
      alfredState.artifacts.push(artifactPath);
    }
  };
  const setFetchedPages: LeadAgentToolContext["setFetchedPages"] = (pages) => {
    alfredState.fetchedPages = pages;
  };
  const getFetchedPages: LeadAgentToolContext["getFetchedPages"] = () => alfredState.fetchedPages;

  const toolContext: LeadAgentToolContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    message: options.message,
    deadlineAtMs,
    policyMode: options.policyMode,
    projectRoot: process.cwd(),
    runStore: options.runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    openAiApiKey: options.openAiApiKey,
    defaults: options.defaults,
    leadPipelineExecutor: options.leadPipelineExecutor,
    state: alfredState,
    isCancellationRequested: options.isCancellationRequested,
    addLeads,
    addArtifact,
    setFetchedPages,
    getFetchedPages
  };

  const observations: Array<{ iteration: number; summary: string; outcome: string }> = [];
  let plannerCallsUsed = 0;
  let toolCallsUsed = 0;
  let lastDelegationSummary = "No delegation attempted yet.";
  let lastCompletionNote = "No completion evaluation yet.";
  const scratchpad: Record<string, unknown> = {
    currentTurnObjective: options.message
  };
  const structuredChatRunner = options.structuredChatRunner ?? openAiClient.runOpenAiStructuredChatWithDiagnostics;
  const agentLoopRunner = options.agentLoopRunner ?? runAgentLoop;
  const buildLeadAgentRuntimeOptions = (message: string): LeadAgentRuntimeOptions => ({
    scratchpad,
    runStore: options.runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    message,
    runId: options.runId,
    sessionId: options.sessionId,
    openAiApiKey: options.openAiApiKey,
    defaults: options.defaults,
    leadPipelineExecutor: options.leadPipelineExecutor,
    maxIterations: options.maxIterations,
    maxDurationMs: Math.max(60_000, options.maxDurationMs - (Date.now() - startMs)),
    maxToolCalls: options.maxToolCalls,
    maxParallelTools: options.maxParallelTools,
    plannerMaxCalls: options.plannerMaxCalls,
    observationWindow: options.observationWindow,
    diminishingThreshold: options.diminishingThreshold,
    policyMode: options.policyMode,
    isCancellationRequested: options.isCancellationRequested
  });

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "alfred_loop_started",
    payload: {
      maxIterations: options.maxIterations,
      maxDurationMs: options.maxDurationMs,
      availableAgents,
      availableTools: availableToolSpecs,
      promptStack: {
        master: ALFRED_MASTER_PROMPT_VERSION
      }
    },
    timestamp: nowIso()
  });

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    if (await options.isCancellationRequested()) {
      return {
        status: "cancelled",
        assistantText: "Run cancelled by user request."
      };
    }
    if (Date.now() >= deadlineAtMs) {
      break;
    }

    if (!options.openAiApiKey) {
      const leadOutcome = await agentLoopRunner({
        skillName: "lead_agent",
        ...buildLeadAgentRuntimeOptions(options.message)
      });
      return leadOutcome;
    }

    const plannerDiagnostic = await structuredChatRunner(
      {
        apiKey: options.openAiApiKey,
        schemaName: "alfred_orchestrator_plan",
        jsonSchema: ALFRED_PLANNER_OUTPUT_JSON_SCHEMA,
        messages: [
          {
            role: "system",
            content: buildAlfredPlannerSystemPrompt()
          },
          {
            role: "user",
            content: JSON.stringify({
              turnObjective: options.message,
              iteration,
              remainingMs: Math.max(0, deadlineAtMs - Date.now()),
              availableAgents,
              availableTools: availableToolSpecs,
              recentObservations: observations.slice(-5),
              lastDelegationSummary,
              lastCompletionNote
            })
          }
        ]
      },
      AlfredPlannerOutputSchema
    );

    plannerCallsUsed += 1;
    if (plannerDiagnostic.usage) {
      await options.runStore.addLlmUsage(options.runId, plannerDiagnostic.usage, 1);
    }

    if (!plannerDiagnostic.result) {
      observations.push({
        iteration,
        summary: "planner_failed",
        outcome: plannerDiagnostic.failureMessage?.slice(0, 220) ?? "planner_failed"
      });
      if (observations.length >= 2) {
        break;
      }
      continue;
    }

    const plan = plannerDiagnostic.result;
    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "alfred_plan_created",
      payload: {
        iteration,
        thought: plan.thought,
        actionType: plan.actionType,
        delegateAgent: plan.delegateAgent,
        toolName: plan.toolName
      },
      timestamp: nowIso()
    });

    if (plan.actionType === "respond") {
      return {
        status: "completed",
        assistantText: plan.responseText ?? lastDelegationSummary,
        artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
      };
    }

    if (plan.actionType === "delegate_agent") {
      const agentName = plan.delegateAgent?.trim().toLowerCase();
      if (!agentName || !availableAgents.some((agent) => agent.name === agentName)) {
        observations.push({
          iteration,
          summary: `unsupported_delegate:${plan.delegateAgent ?? "null"}`,
          outcome: "unsupported_delegate_agent"
        });
        continue;
      }

      const delegatedMessage = (plan.delegateBrief ?? options.message).slice(0, 1200);
      const delegationId = `delegation_${iteration}`;
      scratchpad[`delegation.${delegationId}.brief`] = delegatedMessage;
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "thought",
        eventType: "agent_delegated",
        payload: {
          iteration,
          delegationId,
          agentName,
          brief: delegatedMessage,
          scratchpadKeys: Object.keys(scratchpad).sort()
        },
        timestamp: nowIso()
      });
      const leadOutcome = await agentLoopRunner({
        skillName: agentName,
        parentRunId: options.runId,
        delegationId,
        ...buildLeadAgentRuntimeOptions(delegatedMessage)
      });
      scratchpad[`delegation.${delegationId}.result`] = {
        status: leadOutcome.status,
        assistantText: (leadOutcome.assistantText ?? "").slice(0, 400),
        artifactPaths: leadOutcome.artifactPaths ?? []
      };
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "agent_delegation_result",
        payload: {
          iteration,
          delegationId,
          agentName,
          status: leadOutcome.status,
          artifactCount: leadOutcome.artifactPaths?.length ?? 0,
          scratchpadKeys: Object.keys(scratchpad).sort()
        },
        timestamp: nowIso()
      });

      const runRecord = await options.runStore.getRun(options.runId);
      const recentToolCalls = runRecord?.toolCalls.slice(-6) ?? [];
      toolCallsUsed = runRecord?.toolCalls.length ?? toolCallsUsed;
      if (leadOutcome.artifactPaths?.length) {
        for (const artifact of leadOutcome.artifactPaths) {
          addArtifact(artifact);
        }
      }
      if (runRecord?.artifactPaths?.length) {
        for (const artifact of runRecord.artifactPaths) {
          addArtifact(artifact);
        }
      }

      lastDelegationSummary = [
        `status=${leadOutcome.status}`,
        `assistantText=${(leadOutcome.assistantText ?? "").slice(0, 400)}`,
        `recentTools=${recentToolCalls.map((call) => `${call.toolName}:${call.status}`).join(", ")}`
      ].join(" | ");

      observations.push({
        iteration,
        summary: `delegate_lead_agent`,
        outcome: lastDelegationSummary.slice(0, 500)
      });

      if (leadOutcome.status === "cancelled") {
        return leadOutcome;
      }

      if (plannerCallsUsed < options.plannerMaxCalls) {
        const completionDiagnostic = await runCompletionEvaluator({
          apiKey: options.openAiApiKey,
          structuredChatRunner,
          message: options.message,
          iteration,
          remainingMs: Math.max(0, deadlineAtMs - Date.now()),
          recentObservations: observations,
          lastDelegationSummary,
          actionSummary: `delegate_agent:${agentName}`,
          latestResult: {
            status: leadOutcome.status,
            assistantText: leadOutcome.assistantText,
            artifactPaths: leadOutcome.artifactPaths
          }
        });
        plannerCallsUsed += 1;
        if (completionDiagnostic.usage) {
          await options.runStore.addLlmUsage(options.runId, completionDiagnostic.usage, 1);
        }
        const completionResult = completionDiagnostic.result;
        if (completionResult) {
          lastCompletionNote = completionResult.shouldRespond
            ? `Completion evaluator: respond now (${completionResult.confidence.toFixed(2)} confidence).`
            : `Completion evaluator: continue gathering. ${completionResult.continueReason ?? completionResult.thought}`;
          await options.runStore.appendEvent({
            runId: options.runId,
            sessionId: options.sessionId,
            phase: "thought",
            eventType: "alfred_completion_evaluated",
            payload: {
              iteration,
              actionSummary: `delegate_agent:${agentName}`,
              shouldRespond: completionResult.shouldRespond,
              confidence: completionResult.confidence,
              thought: completionResult.thought,
              continueReason: completionResult.continueReason
            },
            timestamp: nowIso()
          });
          if (completionResult.shouldRespond) {
            return {
              status: "completed",
              assistantText: completionResult.responseText ?? leadOutcome.assistantText ?? lastDelegationSummary,
              artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
            };
          }
          observations.push({
            iteration,
            summary: "completion_eval:continue",
            outcome: (completionResult.continueReason ?? completionResult.thought).slice(0, 260)
          });
        } else if (completionDiagnostic.failureMessage) {
          lastCompletionNote = `Completion evaluator failed: ${completionDiagnostic.failureMessage.slice(0, 180)}`;
        }
      }

      continue;
    }

    if (plan.actionType === "call_tool") {
      const toolName = plan.toolName?.trim() ?? "";
      const tool = availableTools.get(toolName);
      if (!tool) {
        observations.push({
          iteration,
          summary: `tool_not_found:${toolName || "null"}`,
          outcome: "tool_not_found"
        });
        continue;
      }
      const input = parseToolInputJson(plan.toolInputJson);
      if (!input) {
        observations.push({
          iteration,
          summary: `invalid_tool_input:${toolName}`,
          outcome: "invalid_tool_input"
        });
        continue;
      }
      const parsedInput = tool.inputSchema.safeParse(input);
      if (!parsedInput.success) {
        observations.push({
          iteration,
          summary: `tool_schema_error:${toolName}`,
          outcome: parsedInput.error.message.slice(0, 200)
        });
        continue;
      }

      const started = Date.now();
      let toolExecutedSuccessfully = false;
      let latestToolOutput: unknown;
      try {
        const output = await tool.execute(parsedInput.data, toolContext);
        toolCallsUsed += 1;
        toolExecutedSuccessfully = true;
        latestToolOutput = output;
        await options.runStore.addToolCall(options.runId, {
          toolName,
          inputRedacted: redactValue(parsedInput.data),
          outputRedacted: redactValue(output),
          durationMs: Date.now() - started,
          status: "ok",
          timestamp: nowIso()
        });
        observations.push({
          iteration,
          summary: `tool:${toolName}:ok`,
          outcome: JSON.stringify(output).slice(0, 260)
        });
      } catch (error) {
        toolCallsUsed += 1;
        const errorMessage = error instanceof Error ? error.message.slice(0, 220) : "tool_execution_failed";
        await options.runStore.addToolCall(options.runId, {
          toolName,
          inputRedacted: redactValue(parsedInput.data),
          outputRedacted: { error: errorMessage },
          durationMs: Date.now() - started,
          status: "error",
          timestamp: nowIso()
        });
        observations.push({
          iteration,
          summary: `tool:${toolName}:error`,
          outcome: errorMessage
        });
      }

      if (toolExecutedSuccessfully && plannerCallsUsed < options.plannerMaxCalls) {
        const completionDiagnostic = await runCompletionEvaluator({
          apiKey: options.openAiApiKey,
          structuredChatRunner,
          message: options.message,
          iteration,
          remainingMs: Math.max(0, deadlineAtMs - Date.now()),
          recentObservations: observations,
          lastDelegationSummary,
          actionSummary: `call_tool:${toolName}`,
          latestResult: latestToolOutput
        });
        plannerCallsUsed += 1;
        if (completionDiagnostic.usage) {
          await options.runStore.addLlmUsage(options.runId, completionDiagnostic.usage, 1);
        }
        const completionResult = completionDiagnostic.result;
        if (completionResult) {
          lastCompletionNote = completionResult.shouldRespond
            ? `Completion evaluator: respond now (${completionResult.confidence.toFixed(2)} confidence).`
            : `Completion evaluator: continue gathering. ${completionResult.continueReason ?? completionResult.thought}`;
          await options.runStore.appendEvent({
            runId: options.runId,
            sessionId: options.sessionId,
            phase: "thought",
            eventType: "alfred_completion_evaluated",
            payload: {
              iteration,
              actionSummary: `call_tool:${toolName}`,
              shouldRespond: completionResult.shouldRespond,
              confidence: completionResult.confidence,
              thought: completionResult.thought,
              continueReason: completionResult.continueReason
            },
            timestamp: nowIso()
          });
          if (completionResult.shouldRespond) {
            return {
              status: "completed",
              assistantText: completionResult.responseText ?? JSON.stringify(latestToolOutput).slice(0, 1000),
              artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
            };
          }
          observations.push({
            iteration,
            summary: "completion_eval:continue",
            outcome: (completionResult.continueReason ?? completionResult.thought).slice(0, 260)
          });
        } else if (completionDiagnostic.failureMessage) {
          lastCompletionNote = `Completion evaluator failed: ${completionDiagnostic.failureMessage.slice(0, 180)}`;
        }
      }
    }

    if (plannerCallsUsed >= options.plannerMaxCalls || toolCallsUsed >= options.maxToolCalls) {
      break;
    }
  }

  const fallbackText =
    lastDelegationSummary !== "No delegation attempted yet."
      ? `Alfred orchestration stopped by budget guardrails. Latest specialist result: ${lastDelegationSummary}`
      : "Alfred orchestration stopped by budget guardrails before producing a conclusive result.";
  return {
    status: "completed",
    assistantText: fallbackText,
    artifactPaths: alfredState.artifacts.length > 0 ? [...alfredState.artifacts] : undefined
  };
}
