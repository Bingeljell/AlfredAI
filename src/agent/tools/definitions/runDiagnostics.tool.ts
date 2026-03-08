import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { RunEvent, RunRecord, ToolCallRecord } from "../../../types.js";
import type { LeadAgentToolDefinition } from "../../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";

const RunDiagnosticsToolInputSchema = z
  .object({
    runId: z.string().min(1).max(120).optional(),
    debugExportPath: z.string().min(1).max(600).optional(),
    includeEventTypeCounts: z.boolean().optional(),
    maxErrorSamples: z.number().int().min(1).max(25).optional()
  })
  .refine((value) => Boolean(value.runId || value.debugExportPath), {
    message: "Provide runId or debugExportPath"
  });

interface DiagnosticsSourceData {
  sourceType: "run_store" | "debug_export";
  sourcePath?: string;
  run: RunRecord;
  events: RunEvent[];
}

function parseDebugExport(raw: string): DiagnosticsSourceData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("debug export is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("debug export payload is malformed");
  }

  const record = parsed as Record<string, unknown>;
  const run = record.run;
  const events = record.events;
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error("debug export is missing run object");
  }
  if (!Array.isArray(events)) {
    throw new Error("debug export is missing events array");
  }

  return {
    sourceType: "debug_export",
    run: run as RunRecord,
    events: events as RunEvent[]
  };
}

function normalizeToolErrors(toolCalls: ToolCallRecord[]): Array<{ toolName: string; count: number }> {
  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    if (call.status !== "error") {
      continue;
    }
    counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([toolName, count]) => ({ toolName, count }))
    .sort((a, b) => (a.count === b.count ? a.toolName.localeCompare(b.toolName) : b.count - a.count));
}

function collectFailureSignals(events: RunEvent[]): {
  searchFailureCount: number;
  browseFailureCount: number;
  extractionFailureCount: number;
  semanticMissCount: number;
  retrievalBlockedCount: number;
  llmBudgetExhausted: boolean;
} {
  let searchFailureCount = 0;
  let browseFailureCount = 0;
  let extractionFailureCount = 0;
  let semanticMissCount = 0;
  let retrievalBlockedCount = 0;
  let llmBudgetExhausted = false;

  for (const event of events) {
    if (event.eventType !== "agent_action_result") {
      continue;
    }
    const payload = event.payload;
    const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    searchFailureCount += asNumber(payload.searchFailureCount);
    browseFailureCount += asNumber(payload.browseFailureCount);
    extractionFailureCount += asNumber(payload.extractionFailureCount);
    semanticMissCount += asNumber(payload.semanticMissCount);
    retrievalBlockedCount += asNumber(payload.retrievalBlockedCount);
    if (payload.hadLlmBudgetExhausted === true) {
      llmBudgetExhausted = true;
    }
  }

  return {
    searchFailureCount,
    browseFailureCount,
    extractionFailureCount,
    semanticMissCount,
    retrievalBlockedCount,
    llmBudgetExhausted
  };
}

function summarizeStopReasons(events: RunEvent[]): Array<{ reason: string; count: number; latestExplanation?: string }> {
  const counts = new Map<string, { count: number; latestExplanation?: string }>();
  for (const event of events) {
    if (event.eventType !== "agent_stop") {
      continue;
    }
    const reason = typeof event.payload.reason === "string" ? event.payload.reason : "unknown";
    const explanation =
      typeof event.payload.explanation === "string" ? event.payload.explanation.slice(0, 220) : undefined;
    const current = counts.get(reason) ?? { count: 0, latestExplanation: undefined };
    counts.set(reason, {
      count: current.count + 1,
      latestExplanation: explanation ?? current.latestExplanation
    });
  }
  return Array.from(counts.entries())
    .map(([reason, value]) => ({
      reason,
      count: value.count,
      latestExplanation: value.latestExplanation
    }))
    .sort((a, b) => b.count - a.count);
}

function eventTypeCounts(events: RunEvent[]): Array<{ eventType: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.eventType, (counts.get(event.eventType) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([eventType, count]) => ({ eventType, count }))
    .sort((a, b) => (a.count === b.count ? a.eventType.localeCompare(b.eventType) : b.count - a.count));
}

function buildRecommendations(args: {
  errorToolCallCount: number;
  toolErrors: Array<{ toolName: string; count: number }>;
  failureSignals: ReturnType<typeof collectFailureSignals>;
  finalAnswerEventCount: number;
  stopReasons: Array<{ reason: string; count: number; latestExplanation?: string }>;
}): string[] {
  const recommendations: string[] = [];
  if (args.errorToolCallCount > 0) {
    const top = args.toolErrors[0];
    recommendations.push(
      `Investigate tool errors first${top ? ` (top: ${top.toolName} x${top.count})` : ""}; this blocks reliable execution.`
    );
  }
  if (args.failureSignals.searchFailureCount > 0) {
    recommendations.push("Search failures detected; verify provider health, auth, and fallback wiring.");
  }
  if (args.failureSignals.browseFailureCount > 0) {
    recommendations.push("Browse failures detected; filter non-HTML targets (PDF/download links) before crawling.");
  }
  if (args.failureSignals.semanticMissCount > 0) {
    recommendations.push("Semantic miss signaled; tighten query intent and extraction constraints for better fit.");
  }
  if (args.failureSignals.llmBudgetExhausted) {
    recommendations.push("LLM budget exhausted in-loop; reduce per-iteration call caps or batch sizes.");
  }
  if (args.finalAnswerEventCount > 1) {
    recommendations.push("Multiple final_answer events detected; treat nested sub-agent finals separately in timeline UI.");
  }
  if (args.stopReasons.some((item) => item.reason === "budget_exhausted")) {
    recommendations.push("Run stopped due to budget; increase duration/call budget or reduce expensive actions earlier.");
  }
  return recommendations;
}

export const toolDefinition: LeadAgentToolDefinition<typeof RunDiagnosticsToolInputSchema> = {
  name: "run_diagnostics",
  description: "Analyze run timeline/tool telemetry and summarize likely failure points with recommendations.",
  inputSchema: RunDiagnosticsToolInputSchema,
  inputHint: "Use after poor runs to pinpoint failure sources before retrying.",
  async execute(input, context) {
    let source: DiagnosticsSourceData | undefined;

    if (input.debugExportPath) {
      const absolute = resolvePathInProject(context.projectRoot, input.debugExportPath);
      const raw = await readFile(absolute, "utf8");
      const parsed = parseDebugExport(raw);
      source = {
        ...parsed,
        sourcePath: toProjectRelative(context.projectRoot, absolute)
      };
    } else if (input.runId) {
      const run = await context.runStore.getRun(input.runId);
      if (!run) {
        throw new Error(`run not found: ${input.runId}`);
      }
      const events = await context.runStore.listRunEvents(run);
      source = {
        sourceType: "run_store",
        run,
        events
      };
    }

    if (!source) {
      throw new Error("unable to resolve diagnostics source");
    }

    const run = source.run;
    const events = source.events;
    const toolCalls = Array.isArray(run.toolCalls) ? run.toolCalls : [];
    const errorToolCalls = toolCalls.filter((call) => call.status === "error");
    const toolErrors = normalizeToolErrors(toolCalls);
    const failureSignals = collectFailureSignals(events);
    const stopReasons = summarizeStopReasons(events);
    const finalAnswerEventCount = events.filter((event) => event.eventType === "final_answer").length;
    const recommendations = buildRecommendations({
      errorToolCallCount: errorToolCalls.length,
      toolErrors,
      failureSignals,
      finalAnswerEventCount,
      stopReasons
    });
    const maxErrorSamples = input.maxErrorSamples ?? 8;

    return {
      sourceType: source.sourceType,
      sourcePath: source.sourcePath ?? null,
      run: {
        runId: run.runId,
        sessionId: run.sessionId,
        status: run.status,
        message: run.message,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      },
      counts: {
        toolCallCount: toolCalls.length,
        errorToolCallCount: errorToolCalls.length,
        eventCount: events.length,
        finalAnswerEventCount
      },
      failureSignals,
      stopReasons,
      toolErrors,
      slowestToolCalls: [...toolCalls]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5)
        .map((call) => ({
          toolName: call.toolName,
          status: call.status,
          durationMs: call.durationMs,
          timestamp: call.timestamp
        })),
      errorSamples: errorToolCalls.slice(0, maxErrorSamples).map((call) => ({
        toolName: call.toolName,
        durationMs: call.durationMs,
        timestamp: call.timestamp,
        outputRedacted: call.outputRedacted
      })),
      eventTypeCounts: input.includeEventTypeCounts === false ? [] : eventTypeCounts(events),
      recommendations
    };
  }
};

