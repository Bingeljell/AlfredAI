import { z } from "zod";
import type { RunOutcome } from "../types.js";
import * as openAiClient from "../services/openAiClient.js";
import { composeSystemPrompt } from "../prompts/composePrompt.js";
import { ALFRED_MASTER_PROMPT_VERSION, ALFRED_MASTER_SYSTEM_PROMPT } from "../prompts/master/alfred.system.js";
import type { AgentSkillRunOptions } from "../agent/skills/types.js";
import type { LeadAgentState, LeadAgentToolContext } from "../agent/types.js";
import { applyToolAllowlist, discoverLeadAgentTools } from "../agent/tools/registry.js";
import { redactValue } from "../utils/redact.js";

interface SpecialistToolLoopOptions extends AgentSkillRunOptions {
  skillName: string;
  skillDescription: string;
  skillSystemPrompt: string;
  toolAllowlist: string[];
  structuredChatRunner?: typeof openAiClient.runOpenAiStructuredChatWithDiagnostics;
}

interface SpecialistPlannerOutput {
  thought: string;
  actionType: "single" | "parallel" | "respond";
  singleTool: string | null;
  singleInputJson: string | null;
  parallelActions: Array<{ tool: string; inputJson: string }> | null;
  responseText: string | null;
}

interface ToolExecutionResult {
  tool: string;
  status: "ok" | "error";
  durationMs: number;
  summary: string;
  output?: Record<string, unknown>;
  error?: string;
}

const SPECIALIST_PLANNER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string", minLength: 1, maxLength: 600 },
    actionType: { type: "string", enum: ["single", "parallel", "respond"] },
    singleTool: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
    singleInputJson: { anyOf: [{ type: "string", minLength: 2, maxLength: 2400 }, { type: "null" }] },
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
              inputJson: { type: "string", minLength: 2, maxLength: 2400 }
            },
            required: ["tool", "inputJson"]
          }
        },
        { type: "null" }
      ]
    },
    responseText: { anyOf: [{ type: "string", minLength: 1, maxLength: 5000 }, { type: "null" }] }
  },
  required: ["thought", "actionType", "singleTool", "singleInputJson", "parallelActions", "responseText"]
} as const;

const SpecialistPlannerOutputSchema: z.ZodType<SpecialistPlannerOutput> = z.object({
  thought: z.string().min(1).max(600),
  actionType: z.enum(["single", "parallel", "respond"]),
  singleTool: z.string().min(1).max(80).nullable(),
  singleInputJson: z.string().min(2).max(2400).nullable(),
  parallelActions: z
    .array(
      z.object({
        tool: z.string().min(1).max(80),
        inputJson: z.string().min(2).max(2400)
      })
    )
    .max(4)
    .nullable(),
  responseText: z.string().min(1).max(5000).nullable()
});

function nowIso(): string {
  return new Date().toISOString();
}

function parseToolInputJson(inputJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildSpecialistPlannerSystemPrompt(options: Pick<SpecialistToolLoopOptions, "skillSystemPrompt">): string {
  return composeSystemPrompt([
    {
      label: `Persona ${ALFRED_MASTER_PROMPT_VERSION}`,
      content: ALFRED_MASTER_SYSTEM_PROMPT
    },
    {
      label: "Specialist Role",
      content: options.skillSystemPrompt
    },
    {
      label: "ReAct Directives",
      content:
        "Use iterative reasoning: choose tools, observe output, and replan. Prefer the smallest set of high-yield actions. If objective appears satisfied, return actionType=respond with a concise final answer. For tool actions, always provide valid JSON object input."
    }
  ]);
}

function truncateForPrompt(value: unknown, maxLength = 2200): string {
  const serialized =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, nestedValue) => {
          if (typeof nestedValue === "string" && nestedValue.length > 300) {
            return `${nestedValue.slice(0, 300)}...`;
          }
          return nestedValue;
        });
  return serialized.slice(0, maxLength);
}

function extractArtifactPaths(tool: string, output: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (tool === "write_csv") {
    const csvPath = output.csvPath;
    if (typeof csvPath === "string" && csvPath.trim()) {
      paths.push(csvPath.trim());
    }
  }
  if (tool === "file_write" || tool === "file_edit") {
    const filePath = output.path;
    if (typeof filePath === "string" && filePath.trim()) {
      paths.push(filePath.trim());
    }
  }
  if (tool === "writer_agent") {
    const outputPath = output.outputPath;
    if (typeof outputPath === "string" && outputPath.trim()) {
      paths.push(outputPath.trim());
    }
  }
  return paths;
}

function formatObservationSummary(results: ToolExecutionResult[]): string {
  return results
    .map((result) => {
      if (result.status === "ok") {
        return `${result.tool}:ok(${result.durationMs}ms)`;
      }
      return `${result.tool}:error(${result.error ?? "execution_failed"})`;
    })
    .join(", ");
}

function buildFallbackAssistantText(skillName: string, observations: Array<{ iteration: number; summary: string }>): string {
  if (observations.length === 0) {
    return `${skillName} stopped before producing a conclusive result.`;
  }
  const recent = observations.slice(-4).map((item) => `iter ${item.iteration}: ${item.summary}`).join(" | ");
  return `${skillName} stopped by runtime guardrails. Recent observations: ${recent}`;
}

function createToolContext(options: SpecialistToolLoopOptions, deadlineAtMs: number): LeadAgentToolContext {
  const state: LeadAgentState = {
    leads: [],
    artifacts: [],
    requestedLeadCount: options.leadExecutionBrief?.requestedLeadCount ?? 0,
    fetchedPages: [],
    shortlistedUrls: [],
    executionBrief: options.leadExecutionBrief
  };

  return {
    runId: options.runId,
    sessionId: options.sessionId,
    message: options.message,
    leadExecutionBrief: options.leadExecutionBrief,
    deadlineAtMs,
    policyMode: options.policyMode,
    projectRoot: process.cwd(),
    runStore: options.runStore,
    searchManager: options.searchManager,
    workspaceDir: options.workspaceDir,
    openAiApiKey: options.openAiApiKey,
    defaults: options.defaults,
    leadPipelineExecutor: options.leadPipelineExecutor,
    state,
    isCancellationRequested: options.isCancellationRequested,
    addLeads: (incomingLeads) => {
      let addedCount = 0;
      for (const lead of incomingLeads) {
        const existingIndex = state.leads.findIndex(
          (item) => item.companyName === lead.companyName && item.sourceUrl === lead.sourceUrl
        );
        if (existingIndex >= 0) {
          if (lead.confidence > (state.leads[existingIndex]?.confidence ?? 0)) {
            state.leads[existingIndex] = lead;
          }
          continue;
        }
        state.leads.push(lead);
        addedCount += 1;
      }
      return { addedCount, totalCount: state.leads.length };
    },
    addArtifact: (artifactPath) => {
      if (!state.artifacts.includes(artifactPath)) {
        state.artifacts.push(artifactPath);
      }
    },
    setFetchedPages: (pages) => {
      state.fetchedPages = pages;
    },
    getFetchedPages: () => state.fetchedPages,
    setShortlistedUrls: (urls) => {
      state.shortlistedUrls = Array.from(new Set(urls.map((item) => item.trim()).filter(Boolean)));
    },
    getShortlistedUrls: () => state.shortlistedUrls ?? []
  };
}

export async function runSpecialistToolLoop(options: SpecialistToolLoopOptions): Promise<RunOutcome> {
  if (!options.openAiApiKey) {
    return {
      status: "failed",
      assistantText: `${options.skillName} requires OpenAI API access for planning.`
    };
  }

  const discoveredTools = await discoverLeadAgentTools();
  const availableTools = applyToolAllowlist(discoveredTools, options.toolAllowlist);
  if (availableTools.size === 0) {
    return {
      status: "failed",
      assistantText: `${options.skillName} has no available tools configured.`
    };
  }

  const structuredChatRunner = options.structuredChatRunner ?? openAiClient.runOpenAiStructuredChatWithDiagnostics;
  const startMs = Date.now();
  const deadlineAtMs = startMs + options.maxDurationMs;
  const toolContext = createToolContext(options, deadlineAtMs);
  const observations: Array<{ iteration: number; summary: string }> = [];
  let plannerCallsUsed = 0;
  let toolCallsUsed = 0;

  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "thought",
    eventType: "specialist_loop_started",
    payload: {
      skillName: options.skillName,
      skillDescription: options.skillDescription,
      maxIterations: options.maxIterations,
      maxDurationMs: options.maxDurationMs,
      maxToolCalls: options.maxToolCalls,
      availableTools: Array.from(availableTools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputHint: tool.inputHint
      }))
    },
    timestamp: nowIso()
  });

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    if (await options.isCancellationRequested()) {
      return {
        status: "cancelled",
        assistantText: `${options.skillName} cancelled by user request.`,
        artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
      };
    }
    if (Date.now() >= deadlineAtMs || plannerCallsUsed >= options.plannerMaxCalls || toolCallsUsed >= options.maxToolCalls) {
      break;
    }

    const plannerDiagnostic = await structuredChatRunner(
      {
        apiKey: options.openAiApiKey,
        schemaName: `${options.skillName}_planner`,
        jsonSchema: SPECIALIST_PLANNER_JSON_SCHEMA,
        messages: [
          {
            role: "system",
            content: buildSpecialistPlannerSystemPrompt(options)
          },
          {
            role: "user",
            content: JSON.stringify({
              objective: options.message,
              iteration,
              remainingMs: Math.max(0, deadlineAtMs - Date.now()),
              remainingToolCalls: Math.max(0, options.maxToolCalls - toolCallsUsed),
              availableTools: Array.from(availableTools.values()).map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputHint: tool.inputHint
              })),
              recentObservations: observations.slice(-5)
            })
          }
        ]
      },
      SpecialistPlannerOutputSchema
    );

    plannerCallsUsed += 1;
    if (plannerDiagnostic.usage) {
      await options.runStore.addLlmUsage(options.runId, plannerDiagnostic.usage, 1);
    }
    if (!plannerDiagnostic.result) {
      observations.push({
        iteration,
        summary: `planner_failed:${plannerDiagnostic.failureMessage?.slice(0, 120) ?? "unknown"}`
      });
      continue;
    }

    const plan = plannerDiagnostic.result;
    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "thought",
      eventType: "specialist_plan_created",
      payload: {
        skillName: options.skillName,
        iteration,
        thought: plan.thought,
        actionType: plan.actionType
      },
      timestamp: nowIso()
    });

    if (plan.actionType === "respond") {
      return {
        status: "completed",
        assistantText: plan.responseText ?? buildFallbackAssistantText(options.skillName, observations),
        artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
      };
    }

    const requestedActions =
      plan.actionType === "single"
        ? plan.singleTool && plan.singleInputJson
          ? [{ tool: plan.singleTool, inputJson: plan.singleInputJson }]
          : []
        : (plan.parallelActions ?? []);

    const actions = requestedActions
      .map((action) => ({
        tool: action.tool.trim(),
        inputJson: action.inputJson
      }))
      .filter((action) => action.tool.length > 0)
      .slice(0, Math.max(1, options.maxParallelTools));

    if (actions.length === 0) {
      observations.push({
        iteration,
        summary: "planner_returned_no_action"
      });
      continue;
    }

    const executions = await Promise.all(
      actions.map(async (action): Promise<ToolExecutionResult> => {
        const started = Date.now();
        const tool = availableTools.get(action.tool);
        if (!tool) {
          return {
            tool: action.tool,
            status: "error",
            durationMs: Date.now() - started,
            summary: "tool_not_available",
            error: "tool_not_available"
          };
        }
        const rawInput = parseToolInputJson(action.inputJson);
        if (!rawInput) {
          return {
            tool: action.tool,
            status: "error",
            durationMs: Date.now() - started,
            summary: "invalid_input_json",
            error: "invalid_input_json"
          };
        }
        const parsedInput = tool.inputSchema.safeParse(rawInput);
        if (!parsedInput.success) {
          return {
            tool: action.tool,
            status: "error",
            durationMs: Date.now() - started,
            summary: "tool_schema_validation_failed",
            error: parsedInput.error.message.slice(0, 200)
          };
        }
        try {
          const output = await tool.execute(parsedInput.data, toolContext);
          const outputRecord = output as Record<string, unknown>;
          for (const artifactPath of extractArtifactPaths(action.tool, outputRecord)) {
            toolContext.addArtifact(artifactPath);
          }
          await options.runStore.addToolCall(options.runId, {
            toolName: action.tool,
            inputRedacted: redactValue(parsedInput.data),
            outputRedacted: redactValue(output),
            durationMs: Date.now() - started,
            status: "ok",
            timestamp: nowIso()
          });
          return {
            tool: action.tool,
            status: "ok",
            durationMs: Date.now() - started,
            summary: truncateForPrompt(outputRecord, 220),
            output: outputRecord
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message.slice(0, 220) : "tool_execution_failed";
          await options.runStore.addToolCall(options.runId, {
            toolName: action.tool,
            inputRedacted: redactValue(parsedInput.data),
            outputRedacted: { error: errorMessage },
            durationMs: Date.now() - started,
            status: "error",
            timestamp: nowIso()
          });
          return {
            tool: action.tool,
            status: "error",
            durationMs: Date.now() - started,
            summary: errorMessage,
            error: errorMessage
          };
        }
      })
    );

    toolCallsUsed += executions.length;
    const summary = formatObservationSummary(executions);
    observations.push({
      iteration,
      summary
    });

    await options.runStore.appendEvent({
      runId: options.runId,
      sessionId: options.sessionId,
      phase: "observe",
      eventType: "specialist_action_result",
      payload: {
        skillName: options.skillName,
        iteration,
        summary,
        results: executions.map((item) => ({
          tool: item.tool,
          status: item.status,
          durationMs: item.durationMs,
          summary: item.summary
        }))
      },
      timestamp: nowIso()
    });
  }

  const assistantText = buildFallbackAssistantText(options.skillName, observations);
  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "final",
    eventType: "specialist_stop",
    payload: {
      skillName: options.skillName,
      reason: "budget_or_iteration_guardrail",
      plannerCallsUsed,
      toolCallsUsed
    },
    timestamp: nowIso()
  });

  return {
    status: "completed",
    assistantText,
    artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
  };
}
