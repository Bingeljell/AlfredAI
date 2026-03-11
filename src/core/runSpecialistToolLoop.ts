import { z } from "zod";
import type { RunOutcome } from "../types.js";
import * as openAiClient from "../services/openAiClient.js";
import { composeSystemPrompt } from "../prompts/composePrompt.js";
import { ALFRED_MASTER_PROMPT_VERSION, ALFRED_MASTER_SYSTEM_PROMPT } from "../prompts/master/alfred.system.js";
import type { AgentSkillRunOptions } from "../agent/skills/types.js";
import type { LeadAgentState, LeadAgentToolContext } from "../agent/types.js";
import {
  applyToolAllowlist,
  discoverLeadAgentTools,
  executeToolWithEnvelope,
  type ToolExecutionEnvelope
} from "../agent/tools/registry.js";
import { classifyStructuredFailure, computeRetryDelayMs, sleep } from "./reliability.js";

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

type ToolExecutionResult = ToolExecutionEnvelope & { summary: string };

interface SpecialistTaskContract {
  requiredDeliverable: string;
  requiresDraft: boolean;
  requiresCitations: boolean;
  minimumCitationCount: number;
  doneCriteria: string[];
}

interface SpecialistProgressState {
  successfulToolCalls: number;
  sourceUrls: Set<string>;
  fetchedPageCount: number;
  draftWordCount: number;
  citationCount: number;
  errorSamples: string[];
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
        "Use iterative reasoning: choose tools, observe output, and replan. Prefer the smallest set of high-yield actions. Respect the specialist objective contract you receive in planner input: do not return actionType=respond until required deliverable criteria are satisfied, unless you explicitly report a failure summary with concrete evidence. For tool actions, always provide valid JSON object input."
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

function buildSpecialistTaskContract(options: Pick<SpecialistToolLoopOptions, "skillName" | "message">): SpecialistTaskContract {
  const normalized = options.message.toLowerCase();
  const isResearchSkill = options.skillName === "research_agent";
  const requiresDraft = isResearchSkill && /\b(blog|post|article|draft|write)\b/.test(normalized);
  const requiresCitations = isResearchSkill && /\b(cite|citation|sources?)\b/.test(normalized);
  const minimumCitationCount = requiresCitations ? 2 : 0;

  if (isResearchSkill) {
    return {
      requiredDeliverable: requiresDraft
        ? "Produce a complete research-backed draft response."
        : "Produce a concise research synthesis response.",
      requiresDraft,
      requiresCitations,
      minimumCitationCount,
      doneCriteria: [
        "Gather source evidence from search/fetch outputs.",
        requiresDraft ? "Return full draft text (not only status)." : "Return synthesized findings.",
        requiresCitations ? `Include at least ${minimumCitationCount} citation links.` : "Citations preferred when available."
      ]
    };
  }

  return {
    requiredDeliverable: "Return a complete specialist response for the current objective.",
    requiresDraft: false,
    requiresCitations: false,
    minimumCitationCount: 0,
    doneCriteria: ["Return a complete response for the delegated objective."]
  };
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  return Array.from(new Set(matches.map((item) => item.trim())));
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function createSpecialistProgressState(): SpecialistProgressState {
  return {
    successfulToolCalls: 0,
    sourceUrls: new Set<string>(),
    fetchedPageCount: 0,
    draftWordCount: 0,
    citationCount: 0,
    errorSamples: []
  };
}

function updateSpecialistProgress(progress: SpecialistProgressState, result: ToolExecutionResult): void {
  if (result.status === "error") {
    if (progress.errorSamples.length < 6) {
      progress.errorSamples.push(`${result.tool}: ${result.error ?? "execution_failed"}`);
    }
    return;
  }

  progress.successfulToolCalls += 1;
  const payload = result.result ?? {};
  const payloadText = JSON.stringify(payload);
  for (const url of extractUrls(payloadText)) {
    progress.sourceUrls.add(url);
  }

  if (result.tool === "web_fetch") {
    const pagesFetched = typeof payload.pagesFetched === "number" ? payload.pagesFetched : 0;
    progress.fetchedPageCount += Math.max(0, pagesFetched);
  }

  if (result.tool === "writer_agent") {
    const content = typeof payload.content === "string" ? payload.content : "";
    progress.draftWordCount = Math.max(progress.draftWordCount, countWords(content));
    progress.citationCount = Math.max(progress.citationCount, extractUrls(content).length);
  }

  if (result.tool === "search" && Array.isArray(payload.topResults)) {
    for (const item of payload.topResults) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const url = (item as Record<string, unknown>).url;
      if (typeof url === "string" && url.trim()) {
        progress.sourceUrls.add(url.trim());
      }
    }
  }
}

function evaluateSpecialistContractGate(args: {
  contract: SpecialistTaskContract;
  progress: SpecialistProgressState;
  responseText: string | null;
}): { satisfied: boolean; unmet: string[] } {
  const unmet: string[] = [];
  if (args.contract.requiresDraft) {
    const responseWords = countWords(args.responseText ?? "");
    const hasDraft = args.progress.draftWordCount >= 120 || responseWords >= 180;
    if (!hasDraft) {
      unmet.push("draft_text_missing");
    }
  }
  if (args.contract.requiresCitations) {
    const responseCitationCount = extractUrls(args.responseText ?? "").length;
    const citationCount = Math.max(args.progress.citationCount, responseCitationCount);
    if (citationCount < args.contract.minimumCitationCount) {
      unmet.push("citation_evidence_missing");
    }
  }
  return {
    satisfied: unmet.length === 0,
    unmet
  };
}

function buildResearchFailureSummary(progress: SpecialistProgressState, observations: Array<{ iteration: number; summary: string }>): string {
  const recent = observations.slice(-4).map((item) => `iter ${item.iteration}: ${item.summary}`).join(" | ");
  const errors = progress.errorSamples.length > 0 ? progress.errorSamples.join(" | ") : "none";
  return [
    "research_agent could not complete the requested draft under current run constraints.",
    `Evidence gathered: sourceUrls=${progress.sourceUrls.size}, fetchedPages=${progress.fetchedPageCount}, draftWordCount=${progress.draftWordCount}, citations=${progress.citationCount}.`,
    `Recent errors: ${errors}.`,
    `Recent observations: ${recent || "none"}.`
  ].join(" ");
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
  const taskContract = buildSpecialistTaskContract(options);
  const progress = createSpecialistProgressState();
  const observations: Array<{ iteration: number; summary: string; outcome?: string }> = [];
  let plannerCallsUsed = 0;
  let toolCallsUsed = 0;
  let consecutivePlannerFailures = 0;

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
      taskContract,
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
              taskContract,
              progress: {
                successfulToolCalls: progress.successfulToolCalls,
                sourceUrlCount: progress.sourceUrls.size,
                fetchedPageCount: progress.fetchedPageCount,
                draftWordCount: progress.draftWordCount,
                citationCount: progress.citationCount
              },
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
      consecutivePlannerFailures += 1;
      const failureClass = plannerDiagnostic.failureClass ?? classifyStructuredFailure(plannerDiagnostic);
      const failureMessage = plannerDiagnostic.failureMessage?.slice(0, 220) ?? "planner_failed";
      await options.runStore.appendEvent({
        runId: options.runId,
        sessionId: options.sessionId,
        phase: "observe",
        eventType: "specialist_planner_failed",
        payload: {
          skillName: options.skillName,
          iteration,
          failureClass,
          failureCode: plannerDiagnostic.failureCode ?? "unknown",
          attempts: plannerDiagnostic.attempts ?? 1,
          message: failureMessage
        },
        timestamp: nowIso()
      });
      observations.push({
        iteration,
        summary: `planner_failed:${failureClass}`,
        outcome: failureMessage
      });
      if (failureClass === "policy_block") {
        return {
          status: "failed",
          assistantText: `${options.skillName} blocked by policy/auth: ${failureMessage}`,
          artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
        };
      }
      if (failureClass === "network" || failureClass === "timeout") {
        const delayMs = computeRetryDelayMs(
          consecutivePlannerFailures,
          {
            maxAttempts: 4,
            baseDelayMs: 200,
            maxDelayMs: 1500,
            jitterRatio: 0.15
          },
          undefined
        );
        await sleep(delayMs);
      }
      if (consecutivePlannerFailures >= 3) {
        break;
      }
      continue;
    }
    consecutivePlannerFailures = 0;

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
      const contractGate = evaluateSpecialistContractGate({
        contract: taskContract,
        progress,
        responseText: plan.responseText
      });
      if (!contractGate.satisfied) {
        await options.runStore.appendEvent({
          runId: options.runId,
          sessionId: options.sessionId,
          phase: "thought",
          eventType: "specialist_contract_blocked",
          payload: {
            skillName: options.skillName,
            iteration,
            unmet: contractGate.unmet,
            progress: {
              sourceUrlCount: progress.sourceUrls.size,
              fetchedPageCount: progress.fetchedPageCount,
              draftWordCount: progress.draftWordCount,
              citationCount: progress.citationCount
            }
          },
          timestamp: nowIso()
        });
        observations.push({
          iteration,
          summary: `contract_blocked:${contractGate.unmet.join(",")}`
        });
        continue;
      }
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
        const envelope = await executeToolWithEnvelope({
          toolName: action.tool,
          inputJson: action.inputJson,
          tools: availableTools,
          context: toolContext,
          runStore: options.runStore,
          runId: options.runId
        });
        if (envelope.status === "ok" && envelope.result) {
          for (const artifactPath of extractArtifactPaths(action.tool, envelope.result)) {
            toolContext.addArtifact(artifactPath);
          }
        }
        return {
          ...envelope,
          summary:
            envelope.status === "ok"
              ? truncateForPrompt(envelope.result, 220)
              : envelope.error ?? "execution_failed"
        };
      })
    );
    for (const execution of executions) {
      updateSpecialistProgress(progress, execution);
    }

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
          summary: item.summary,
          requiresApproval: item.requiresApproval,
          inputRepairApplied: item.inputRepairApplied,
          inputRepairStrategy: item.inputRepairStrategy,
          input: item.input,
          result: item.result,
          error: item.error
        }))
      },
      timestamp: nowIso()
    });
  }

  const unmetContract = evaluateSpecialistContractGate({
    contract: taskContract,
    progress,
    responseText: null
  });
  const assistantText =
    options.skillName === "research_agent" && !unmetContract.satisfied
      ? buildResearchFailureSummary(progress, observations)
      : buildFallbackAssistantText(options.skillName, observations);
  await options.runStore.appendEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    phase: "final",
    eventType: "specialist_stop",
    payload: {
      skillName: options.skillName,
      reason: "budget_or_iteration_guardrail",
      plannerCallsUsed,
      toolCallsUsed,
      unmetContract: unmetContract.unmet
    },
    timestamp: nowIso()
  });

  return {
    status: "completed",
    assistantText,
    artifactPaths: toolContext.state.artifacts.length > 0 ? [...toolContext.state.artifacts] : undefined
  };
}
