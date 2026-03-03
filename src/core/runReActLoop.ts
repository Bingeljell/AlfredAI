import type { PolicyMode, RunOutcome, ToolCallRecord } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import { buildLeadCandidates } from "../tools/lead/leadPipeline.js";
import { writeLeadsCsv } from "../tools/csv/writeCsv.js";
import { evaluateApprovalNeed } from "./approvalPolicy.js";
import { runOpenAiChat } from "../services/openAiClient.js";
import { appendDailyNote } from "../memory/dailyNotes.js";
import { redactValue } from "../utils/redact.js";
import type { SearchResult } from "../types.js";

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
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeQuery(input: string): string {
  return input
    .replace(/^(alfred[,\s-]*)?/i, "")
    .replace(/find\s+\d+\s+leads?/i, "find leads")
    .trim();
}

function parseRequestedLeadCount(message: string): number {
  const match = message.match(/\b(?:find|generate|get)\s+(\d{1,3})\s+.*?\bleads?\b/i);
  if (!match) {
    return 50;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(100, Math.max(10, parsed));
}

function parseLocationHint(message: string): string | undefined {
  const match = message.match(/\bin\s+([A-Za-z][A-Za-z\s]{1,40})$/i);
  return match?.[1]?.trim();
}

function buildSearchQueries(message: string): string[] {
  const normalized = normalizeQuery(message) || "find B2B startup leads";
  const location = parseLocationHint(message) ?? "USA";
  const lower = normalized.toLowerCase();

  const querySet = new Set<string>();
  querySet.add(normalized);
  querySet.add(`top managed service providers in ${location}`);

  if (/\bsi\b|system integrator/i.test(lower)) {
    querySet.add(`system integrator companies in ${location}`);
  }
  if (/\bmsp\b|managed service provider/i.test(lower)) {
    querySet.add(`managed service provider directory ${location}`);
  }
  if (querySet.size < 3) {
    querySet.add(`it services companies list ${location}`);
  }

  return Array.from(querySet).slice(0, 3);
}

function mergeUniqueSearchResults(results: SearchResult[][]): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  for (const batch of results) {
    for (const result of batch) {
      if (!unique.has(result.url)) {
        unique.set(result.url, {
          ...result,
          rank: unique.size + 1
        });
      }
    }
  }
  return Array.from(unique.values());
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
    payload: { intent: "lead_generation" },
    timestamp: nowIso()
  });

  const query = normalizeQuery(message) || "find B2B startup leads";
  const searchQueries = buildSearchQueries(message);
  const requestedLeadCount = parseRequestedLeadCount(message);
  const searchStart = Date.now();
  const searchResponses = [];
  for (const currentQuery of searchQueries) {
    searchResponses.push(await options.searchManager.search(currentQuery, options.searchMaxResults));
  }
  const mergedResults = mergeUniqueSearchResults(searchResponses.map((item) => item.results));
  const primaryProvider = searchResponses[0]?.provider ?? "searxng";
  const anyFallbackUsed = searchResponses.some((item) => item.fallbackUsed);

  await recordToolCall(runStore, runId, {
    toolName: "search",
    inputRedacted: { queries: searchQueries, maxResultsPerQuery: options.searchMaxResults },
    outputRedacted: { provider: primaryProvider, count: mergedResults.length, queryCount: searchQueries.length },
    durationMs: Date.now() - searchStart,
    status: "ok"
  });

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "tool",
    eventType: "search_completed",
    payload: {
      provider: primaryProvider,
      fallbackUsed: anyFallbackUsed,
      resultCount: mergedResults.length,
      queryCount: searchQueries.length
    },
    timestamp: nowIso()
  });

  const scrapeStart = Date.now();
  const candidates = await buildLeadCandidates(mergedResults, {
    fastScrapeCount: options.fastScrapeCount,
    enablePlaywright: options.enablePlaywright,
    targetLeadCount: requestedLeadCount,
    requestMessage: message
  });

  await recordToolCall(runStore, runId, {
    toolName: "lead_pipeline",
    inputRedacted: { resultCount: mergedResults.length, requestedLeadCount },
    outputRedacted: { candidateCount: candidates.length },
    durationMs: Date.now() - scrapeStart,
    status: "ok"
  });

  const csvStart = Date.now();
  const csvPath = await writeLeadsCsv(options.workspaceDir, runId, candidates);

  await recordToolCall(runStore, runId, {
    toolName: "write_csv",
    inputRedacted: { candidateCount: candidates.length },
    outputRedacted: { csvPath },
    durationMs: Date.now() - csvStart,
    status: "ok"
  });

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "persist",
    eventType: "artifact_written",
    payload: { csvPath, candidateCount: candidates.length },
    timestamp: nowIso()
  });

  const llmSummary = await runOpenAiChat({
    apiKey: options.openAiApiKey,
    messages: [
      {
        role: "system",
        content:
          "You are Alfred. Summarize lead-candidate output in 3 concise bullet points and include quality caveat."
      },
      {
        role: "user",
        content: JSON.stringify(
          redactValue({
            query,
            provider: primaryProvider,
            fallbackUsed: anyFallbackUsed,
            candidatePreview: candidates.slice(0, 5)
          })
        )
      }
    ]
  });

  const assistantText =
    llmSummary ??
    [
      `Lead candidate run completed with ${candidates.length} candidates.`,
      `Search provider: ${primaryProvider}${anyFallbackUsed ? " (fallback used)" : ""}.`,
      "Quality is candidate-grade for now; verify before outreach."
    ].join("\n");

  await appendDailyNote(options.workspaceDir, sessionId, "assistant", assistantText);

  await runStore.appendEvent({
    runId,
    sessionId,
    phase: "final",
    eventType: "final_answer",
    payload: {
      candidateCount: candidates.length,
      csvPath,
      provider: primaryProvider,
      fallbackUsed: anyFallbackUsed
    },
    timestamp: nowIso()
  });

  return {
    status: "completed",
    assistantText,
    artifactPaths: [csvPath]
  };
}
