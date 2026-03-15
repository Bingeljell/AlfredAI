import type { ToolCallRecord } from "../types.js";
import type { DebugRunExport } from "./turnRuntimeMetrics.js";

export interface WritingRuntimeMetrics {
  runCount: number;
  writingRunCount: number;
  artifactCompletionRate: number;
  draftEvidenceRate: number;
  citationEvidenceRate: number;
  writerFailureRate: number;
  avgWriterCallsPerWritingRun: number;
}

const WRITER_TOOL_NAMES = new Set(["writer_agent", "article_writer"]);

function normalizeText(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function isWritingRequest(message: string | undefined): boolean {
  const text = normalizeText(message);
  return /\b(write|draft|blog|article|post)\b/.test(text);
}

function countWords(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function countCitationSignals(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const urls = value.match(/https?:\/\/[^\s)>\]]+/gi) ?? [];
  const urlCount = new Set(urls.map((item) => item.trim())).size;
  const bracketRefs = value.match(/\[(\d+)\]/g) ?? [];
  return Math.max(urlCount, new Set(bracketRefs).size);
}

function getWriterCalls(run: DebugRunExport["run"]): ToolCallRecord[] {
  return run.toolCalls.filter((call) => WRITER_TOOL_NAMES.has(call.toolName));
}

function getWriterWordCount(call: ToolCallRecord): number {
  const output = call.outputRedacted as Record<string, unknown> | null | undefined;
  const byField = output && typeof output.wordCount === "number" ? output.wordCount : 0;
  const byContent = output && typeof output.content === "string" ? countWords(output.content) : 0;
  return Math.max(byField, byContent);
}

function getWriterCitations(call: ToolCallRecord): number {
  const output = call.outputRedacted as Record<string, unknown> | null | undefined;
  return output && typeof output.content === "string" ? countCitationSignals(output.content) : 0;
}

function isPlaceholderDraft(call: ToolCallRecord): boolean {
  const output = call.outputRedacted as Record<string, unknown> | null | undefined;
  return output?.draftQuality === "placeholder";
}

export function computeWritingRuntimeMetrics(bundles: DebugRunExport[]): WritingRuntimeMetrics {
  if (bundles.length === 0) {
    return {
      runCount: 0,
      writingRunCount: 0,
      artifactCompletionRate: 0,
      draftEvidenceRate: 0,
      citationEvidenceRate: 0,
      writerFailureRate: 0,
      avgWriterCallsPerWritingRun: 0
    };
  }

  let writingRunCount = 0;
  let artifactCompleted = 0;
  let draftEvidenceRuns = 0;
  let citationEvidenceRuns = 0;
  let writerFailureRuns = 0;
  let totalWriterCalls = 0;

  for (const bundle of bundles) {
    if (!isWritingRequest(bundle.run.message)) {
      continue;
    }
    writingRunCount += 1;
    const writerCalls = getWriterCalls(bundle.run);
    totalWriterCalls += writerCalls.length;

    if ((bundle.run.artifactPaths?.length ?? 0) > 0) {
      artifactCompleted += 1;
    }

    const hasDraftEvidence = writerCalls.some((call) => call.status === "ok" && getWriterWordCount(call) >= 300);
    if (hasDraftEvidence) {
      draftEvidenceRuns += 1;
    }

    const hasCitationEvidence = writerCalls.some((call) => call.status === "ok" && getWriterCitations(call) >= 2);
    if (hasCitationEvidence) {
      citationEvidenceRuns += 1;
    }

    const hasWriterError = writerCalls.some((call) => call.status === "error");
    const allPlaceholder = writerCalls.length > 0 && writerCalls.every((call) => isPlaceholderDraft(call));
    if (hasWriterError || allPlaceholder) {
      writerFailureRuns += 1;
    }
  }

  if (writingRunCount === 0) {
    return {
      runCount: bundles.length,
      writingRunCount: 0,
      artifactCompletionRate: 0,
      draftEvidenceRate: 0,
      citationEvidenceRate: 0,
      writerFailureRate: 0,
      avgWriterCallsPerWritingRun: 0
    };
  }

  return {
    runCount: bundles.length,
    writingRunCount,
    artifactCompletionRate: artifactCompleted / writingRunCount,
    draftEvidenceRate: draftEvidenceRuns / writingRunCount,
    citationEvidenceRate: citationEvidenceRuns / writingRunCount,
    writerFailureRate: writerFailureRuns / writingRunCount,
    avgWriterCallsPerWritingRun: totalWriterCalls / writingRunCount
  };
}

