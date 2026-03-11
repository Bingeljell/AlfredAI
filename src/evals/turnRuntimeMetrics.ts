import type { RunEvent, RunRecord, ToolCallRecord } from "../types.js";

export interface DebugRunExport {
  generatedAt?: string;
  run: RunRecord;
  events: RunEvent[];
}

export interface TurnRuntimeMetrics {
  runCount: number;
  diagnosticRunCount: number;
  wrongModeExecutionRate: number;
  evidenceFaithfulnessRate: number;
  uselessToolCallCount: number;
  yieldPerThousandTokens: number;
}

const EXECUTION_TOOL_NAMES = new Set([
  "search",
  "lead_search_shortlist",
  "lead_pipeline",
  "web_fetch",
  "lead_extract",
  "email_enrich"
]);

function normalizeText(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function isDiagnosticMessage(message: string | undefined): boolean {
  const text = normalizeText(message);
  return (
    text.includes("why") ||
    text.includes("what happened") ||
    text.includes("debug") ||
    text.includes("diagnose") ||
    text.includes("don't run") ||
    text.includes("dont run") ||
    text.includes("don't do anything") ||
    text.includes("dont do anything")
  );
}

function extractCandidateCount(bundle: DebugRunExport): number {
  const finalEvent = [...bundle.events].reverse().find((event) => event.eventType === "final_answer");
  const payloadValue = finalEvent?.payload?.candidateCount;
  if (typeof payloadValue === "number" && Number.isFinite(payloadValue) && payloadValue >= 0) {
    return payloadValue;
  }
  const runValue = bundle.run.toolCalls
    .map((call) => call.outputRedacted)
    .find((output) => typeof output === "object" && output !== null && "finalCandidateCount" in output);
  if (
    typeof runValue === "object" &&
    runValue !== null &&
    typeof (runValue as Record<string, unknown>).finalCandidateCount === "number"
  ) {
    const count = (runValue as Record<string, number>).finalCandidateCount;
    return Number.isFinite(count) && count >= 0 ? count : 0;
  }
  return 0;
}

function extractLeadClaim(assistantText: string | undefined): number | undefined {
  if (!assistantText) {
    return undefined;
  }
  const match = assistantText.match(/(\d+)\s+lead/i);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isUselessToolCall(call: ToolCallRecord): boolean {
  if (call.status === "error") {
    return true;
  }
  if (call.toolName === "search") {
    const output = call.outputRedacted as Record<string, unknown> | undefined;
    return typeof output?.count === "number" && output.count === 0;
  }
  if (call.toolName === "lead_pipeline") {
    const output = call.outputRedacted as Record<string, unknown> | undefined;
    return typeof output?.finalCandidateCount === "number" && output.finalCandidateCount === 0;
  }
  return false;
}

export function computeTurnRuntimeMetrics(bundles: DebugRunExport[]): TurnRuntimeMetrics {
  if (bundles.length === 0) {
    return {
      runCount: 0,
      diagnosticRunCount: 0,
      wrongModeExecutionRate: 0,
      evidenceFaithfulnessRate: 1,
      uselessToolCallCount: 0,
      yieldPerThousandTokens: 0
    };
  }

  let diagnosticRunCount = 0;
  let wrongModeExecutions = 0;
  let faithfulnessChecks = 0;
  let faithfulCount = 0;
  let uselessToolCallCount = 0;
  let totalLeads = 0;
  let totalTokens = 0;

  for (const bundle of bundles) {
    const run = bundle.run;
    const diagnostic = isDiagnosticMessage(run.message);
    if (diagnostic) {
      diagnosticRunCount += 1;
      if (run.toolCalls.some((call) => EXECUTION_TOOL_NAMES.has(call.toolName))) {
        wrongModeExecutions += 1;
      }
    }

    for (const call of run.toolCalls) {
      if (isUselessToolCall(call)) {
        uselessToolCallCount += 1;
      }
    }

    const candidateCount = extractCandidateCount(bundle);
    totalLeads += candidateCount;
    totalTokens += Math.max(0, run.llmUsage?.totalTokens ?? 0);

    const leadClaim = extractLeadClaim(run.assistantText);
    if (typeof leadClaim === "number") {
      faithfulnessChecks += 1;
      if (leadClaim === candidateCount) {
        faithfulCount += 1;
      }
    }
  }

  return {
    runCount: bundles.length,
    diagnosticRunCount,
    wrongModeExecutionRate: diagnosticRunCount > 0 ? wrongModeExecutions / diagnosticRunCount : 0,
    evidenceFaithfulnessRate: faithfulnessChecks > 0 ? faithfulCount / faithfulnessChecks : 1,
    uselessToolCallCount,
    yieldPerThousandTokens: totalTokens > 0 ? (totalLeads / totalTokens) * 1000 : 0
  };
}
