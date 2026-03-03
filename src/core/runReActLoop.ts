import type { PolicyMode, RunOutcome, ToolCallRecord } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import { writeLeadsCsv } from "../tools/csv/writeCsv.js";
import { evaluateApprovalNeed } from "./approvalPolicy.js";
import { runOpenAiChat } from "../services/openAiClient.js";
import { appendDailyNote } from "../memory/dailyNotes.js";
import { redactValue } from "../utils/redact.js";
import { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";

interface RunReActLoopOptions {
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  policyMode: PolicyMode;
  searchMaxResults: number;
  fastScrapeCount: number;
  enablePlaywright: boolean;
  maxSteps: number;
  openAiApiKey?: string;
  subReactMaxPages: number;
  subReactBrowseConcurrency: number;
  subReactBatchSize: number;
  subReactLlmMaxCalls: number;
  subReactMinConfidence: number;
  leadPipelineExecutor?: typeof executeLeadSubReactPipeline;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function recordToolCall(
  runStore: RunStore,
  runId: string,
  call: Omit<ToolCallRecord, "timestamp">
): Promise<void> {
  await runStore.addToolCall(runId, {
    ...call,
    timestamp: nowIso()
  });
}

export async function runReActLoop(
  sessionId: string,
  message: string,
  runId: string,
  options: RunReActLoopOptions
): Promise<RunOutcome> {
  const { runStore } = options;

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "session",
    eventType: "loop_started",
    payload: { maxSteps: options.maxSteps },
    timestamp: nowIso()
  });

  await appendDailyNote(options.workspaceDir, sessionId, "user", message);

  const approval = evaluateApprovalNeed(message, options.policyMode);
  if (approval.needed) {
    await runStore.appendEvent({
      runId,
      sessionId,
      phase: "approval",
      eventType: "approval_required",
      payload: { reason: approval.reason, token: approval.token },
      timestamp: nowIso()
    });

    return {
      status: "needs_approval",
      approvalToken: approval.token,
      assistantText: `Approval required (${approval.token}) before executing this request.`
    };
  }

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "thought",
    eventType: "intent_identified",
    payload: { intent: "lead_generation_sub_react" },
    timestamp: nowIso()
  });

  const pipelineStart = Date.now();
  const leadPipelineExecutor = options.leadPipelineExecutor ?? executeLeadSubReactPipeline;
  const subReactResult = await leadPipelineExecutor({
    runId,
    sessionId,
    message,
    runStore,
    searchManager: options.searchManager,
    openAiApiKey: options.openAiApiKey,
    searchMaxResults: options.searchMaxResults,
    maxPages: options.subReactMaxPages,
    browseConcurrency: options.subReactBrowseConcurrency,
    extractionBatchSize: options.subReactBatchSize,
    llmMaxCalls: options.subReactLlmMaxCalls,
    minConfidence: options.subReactMinConfidence
  });

  await recordToolCall(runStore, runId, {
    toolName: "lead_pipeline",
    inputRedacted: {
      message,
      maxPages: options.subReactMaxPages,
      browseConcurrency: options.subReactBrowseConcurrency,
      extractionBatchSize: options.subReactBatchSize,
      llmMaxCalls: options.subReactLlmMaxCalls,
      minConfidence: options.subReactMinConfidence
    },
    outputRedacted: {
      queryCount: subReactResult.queryCount,
      pagesVisited: subReactResult.pagesVisited,
      rawCandidateCount: subReactResult.rawCandidateCount,
      validatedCandidateCount: subReactResult.validatedCandidateCount,
      finalCandidateCount: subReactResult.finalCandidateCount,
      llmCallsUsed: subReactResult.llmCallsUsed,
      llmCallsRemaining: subReactResult.llmCallsRemaining,
      deficitCount: subReactResult.deficitCount
    },
    durationMs: Date.now() - pipelineStart,
    status: "ok"
  });

  const csvStart = Date.now();
  const csvPath = await writeLeadsCsv(options.workspaceDir, runId, subReactResult.leads);

  await recordToolCall(runStore, runId, {
    toolName: "write_csv",
    inputRedacted: { candidateCount: subReactResult.leads.length },
    outputRedacted: { csvPath },
    durationMs: Date.now() - csvStart,
    status: "ok"
  });

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "persist",
    eventType: "artifact_written",
    payload: {
      csvPath,
      candidateCount: subReactResult.leads.length,
      llmCallsUsed: subReactResult.llmCallsUsed,
      llmCallsRemaining: subReactResult.llmCallsRemaining
    },
    timestamp: nowIso()
  });

  let llmSummary: string | undefined;
  if (options.openAiApiKey && subReactResult.llmCallsRemaining > 0) {
    llmSummary = await runOpenAiChat({
      apiKey: options.openAiApiKey,
      messages: [
        {
          role: "system",
          content:
            "You are Alfred. Summarize lead extraction outcome in 4 concise bullets with quality notes and explicit deficit if present."
        },
        {
          role: "user",
          content: JSON.stringify(
            redactValue({
              requestMessage: message,
              requestedLeadCount: subReactResult.requestedLeadCount,
              queryCount: subReactResult.queryCount,
              pagesVisited: subReactResult.pagesVisited,
              rawCandidateCount: subReactResult.rawCandidateCount,
              validatedCandidateCount: subReactResult.validatedCandidateCount,
              finalCandidateCount: subReactResult.finalCandidateCount,
              deficitCount: subReactResult.deficitCount,
              candidatePreview: subReactResult.leads.slice(0, 5)
            })
          )
        }
      ]
    });
  }

  const deficitMessage =
    subReactResult.deficitCount > 0
      ? `Requested ${subReactResult.requestedLeadCount}, returned ${subReactResult.finalCandidateCount} validated leads (deficit ${subReactResult.deficitCount}).`
      : `Returned ${subReactResult.finalCandidateCount} validated leads.`;

  const assistantText =
    llmSummary ??
    [
      `Lead sub-ReAct completed with ${subReactResult.finalCandidateCount} validated leads.`,
      `Visited ${subReactResult.pagesVisited} pages across ${subReactResult.queryCount} queries.`,
      `LLM calls used: ${subReactResult.llmCallsUsed}/${options.subReactLlmMaxCalls}.`,
      deficitMessage
    ].join("\n");

  await appendDailyNote(options.workspaceDir, sessionId, "assistant", assistantText);

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "final",
    eventType: "final_answer",
    payload: {
      candidateCount: subReactResult.finalCandidateCount,
      requestedLeadCount: subReactResult.requestedLeadCount,
      deficitCount: subReactResult.deficitCount,
      csvPath,
      llmCallsUsed: subReactResult.llmCallsUsed,
      llmCallsRemaining: subReactResult.llmCallsRemaining
    },
    timestamp: nowIso()
  });

  return {
    status: "completed",
    assistantText,
    artifactPaths: [csvPath]
  };
}
