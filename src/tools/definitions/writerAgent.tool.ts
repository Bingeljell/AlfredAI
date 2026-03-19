import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmUsage, TurnOutputShape } from "../../types.js";
import type { LeadAgentToolDefinition, ResearchSourceCard } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";
import { OpenAiLlmProvider } from "../../provider/openai.js";
import { runTextWithFallback } from "../../provider/router.js";
import type { LlmProvider } from "../../provider/types.js";

const WriterAgentToolInputSchema = z.object({
  instruction: z.string().min(8).max(3000),
  format: z.enum(["blog_post", "email", "memo", "outline", "social_post", "notes"]).optional(),
  outputShapeHint: z.enum(["article", "ranked_list", "comparison", "brief", "memo", "email", "outline", "social_post", "notes", "rewrite", "generic", "list", "table", "csv"]).optional(),
  audience: z.string().min(2).max(120).optional(),
  tone: z.string().min(2).max(120).optional(),
  maxWords: z.number().int().min(80).max(3000).optional(),
  contextPaths: z.array(z.string().min(1).max(600)).max(8).optional(),
  outputPath: z.string().min(1).max(600).optional(),
  overwrite: z.boolean().optional()
});

type WriterFormat = "blog_post" | "email" | "memo" | "outline" | "social_post" | "notes";
type WriterOutputShape = Extract<TurnOutputShape, "article" | "ranked_list" | "comparison" | "brief" | "memo" | "email" | "outline" | "social_post" | "notes" | "rewrite" | "generic" | "list" | "table" | "csv">;
type WriterDeliverableStatus = "complete" | "partial" | "insufficient";

const WRITER_RESERVED_TIME_MS = 10_000;
const GENERATION_TIMEOUT_MS = 55_000;
const GENERATION_MIN_TIMEOUT_MS = 7_000;
const GENERATION_MAX_ATTEMPTS = 2;
const MAX_SOURCE_CARDS_FOR_PROMPT = 14;

interface WriterCallBudget {
  enabled: boolean;
  maxAttempts: number;
  timeoutMs: number;
  remainingMs: number;
  skipReason?: string;
}

interface SourceIndexEntry {
  id: number;
  url: string;
  title: string;
  claim: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clipText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trim()}…`;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function clipWords(text: string, maxWords: number): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= maxWords) {
    return text.trim();
  }
  return parts.slice(0, maxWords).join(" ").trim();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const rounded = Math.round(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

function countMessageChars(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function llmTimingPayload(result: {
  elapsedMs?: number;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  softTimeoutExceeded?: boolean;
  attempts?: number;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof result.elapsedMs === "number") {
    payload.elapsedMs = result.elapsedMs;
  }
  if (typeof result.softTimeoutMs === "number") {
    payload.softTimeoutMs = result.softTimeoutMs;
  }
  if (typeof result.hardTimeoutMs === "number") {
    payload.hardTimeoutMs = result.hardTimeoutMs;
  }
  if (typeof result.softTimeoutExceeded === "boolean") {
    payload.softTimeoutExceeded = result.softTimeoutExceeded;
  }
  if (typeof result.attempts === "number") {
    payload.llmAttempts = result.attempts;
  }
  return payload;
}

function deriveTitle(instruction: string): string {
  const trimmed = instruction.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "Draft";
  }
  return clipText(trimmed, 80);
}

function deriveTitleFromContent(content: string): string {
  const firstNonEmpty = content.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstNonEmpty) {
    return "Draft";
  }
  return clipText(firstNonEmpty.replace(/^#+\s*/, ""), 160);
}

function normalizeWriterFormat(value: unknown): WriterFormat {
  if (typeof value !== "string") {
    return "blog_post";
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  switch (normalized) {
    case "article":
    case "blog":
    case "blogpost":
    case "blog_post":
    case "blog_article":
    case "news":
    case "news_article":
      return "blog_post";
    case "email":
      return "email";
    case "memo":
      return "memo";
    case "outline":
      return "outline";
    case "social":
    case "social_post":
      return "social_post";
    case "note":
    case "notes":
      return "notes";
    default:
      return "blog_post";
  }
}

function defaultShapeForFormat(format: WriterFormat): WriterOutputShape {
  switch (format) {
    case "email":
      return "email";
    case "memo":
      return "memo";
    case "outline":
      return "outline";
    case "social_post":
      return "social_post";
    case "notes":
      return "notes";
    default:
      return "article";
  }
}

function buildDefaultSessionOutputPath(args: {
  sessionId: string;
  runId: string;
  format: WriterFormat;
}): string {
  const suffix = args.format === "blog_post" ? "article" : args.format;
  return path.posix.join("workspace", "alfred", "sessions", args.sessionId, "outputs", `${args.runId}-${suffix}.md`);
}

function buildSourceIndex(cards: ResearchSourceCard[]): SourceIndexEntry[] {
  return cards.slice(0, MAX_SOURCE_CARDS_FOR_PROMPT).map((card, index) => ({
    id: index + 1,
    url: card.url,
    title: card.title ? clipText(card.title, 90) : "Untitled source",
    claim: clipText(card.claim || "No claim extracted.", 180)
  }));
}

function formatSourceIndexForPrompt(sourceIndex: SourceIndexEntry[]): string {
  if (sourceIndex.length === 0) {
    return "Available sources: none";
  }
  return `Available sources:\n${sourceIndex.map((item) => `- [S${item.id}] ${item.title} | ${item.url} | key point: ${item.claim}`).join("\n")}`;
}

function formatContextSnippets(contextSnippets: string[]): string {
  if (contextSnippets.length === 0) {
    return "Context snippets: none";
  }
  return `Context snippets:\n${contextSnippets.slice(0, 4).map((item) => `- ${clipText(item, 220)}`).join("\n")}`;
}

async function emitWriterStageEvent(args: {
  context: Parameters<LeadAgentToolDefinition["execute"]>[1];
  stage: string;
  status: "started" | "completed" | "failed" | "skipped";
  payload?: Record<string, unknown>;
}): Promise<void> {
  await args.context.runStore.appendEvent({
    runId: args.context.runId,
    sessionId: args.context.sessionId,
    phase: "tool",
    eventType: "writer_stage",
    payload: {
      stage: args.stage,
      status: args.status,
      ...(args.payload ?? {})
    },
    timestamp: nowIso()
  });
}

async function maybeRecordUsage(context: Parameters<LeadAgentToolDefinition["execute"]>[1], usage: LlmUsage | undefined): Promise<void> {
  if (!usage) {
    return;
  }
  await context.runStore.addLlmUsage(context.runId, usage, 1);
}

async function loadContextSnippets(projectRoot: string, contextPaths: string[] | undefined): Promise<string[]> {
  if (!contextPaths || contextPaths.length === 0) {
    return [];
  }
  const snippets: string[] = [];
  for (const requestedPath of contextPaths) {
    try {
      const absolute = resolvePathInProject(projectRoot, requestedPath);
      const raw = await readFile(absolute, "utf8");
      const normalized = raw.replace(/\s+/g, " ").trim();
      if (!normalized) {
        continue;
      }
      snippets.push(`${toProjectRelative(projectRoot, absolute)}: ${normalized.slice(0, 500)}`);
    } catch {
      continue;
    }
  }
  return snippets;
}

function resolveWriterProviders(context: Parameters<LeadAgentToolDefinition["execute"]>[1]): LlmProvider[] {
  if (Array.isArray(context.llmProviders) && context.llmProviders.length > 0) {
    return context.llmProviders;
  }
  if (context.openAiApiKey) {
    return [new OpenAiLlmProvider({ apiKey: context.openAiApiKey })];
  }
  return [];
}

function computePassBudget(args: {
  deadlineAtMs: number;
  reserveMs: number;
  maxTimeoutMs: number;
  minTimeoutMs: number;
  maxAttempts: number;
}): WriterCallBudget {
  const remainingMs = Math.max(0, args.deadlineAtMs - Date.now());
  const budgetMs = Math.max(0, remainingMs - args.reserveMs);
  if (budgetMs < args.minTimeoutMs + 1_000) {
    return {
      enabled: false,
      maxAttempts: 0,
      timeoutMs: 0,
      remainingMs,
      skipReason: "insufficient_deadline_budget"
    };
  }
  return {
    enabled: true,
    maxAttempts: args.maxAttempts,
    timeoutMs: clampInt(Math.min(args.maxTimeoutMs, budgetMs - 800), args.minTimeoutMs, args.maxTimeoutMs),
    remainingMs
  };
}

function buildFallbackDraft(args: {
  reason: string;
  instruction: string;
  format: string;
  audience: string;
  tone: string;
  maxWords: number;
  contextSnippets: string[];
  sourceCards: ResearchSourceCard[];
}): { title: string; content: string; summary: string; nextSteps: string[] } {
  const sourceBlock = args.sourceCards.length > 0
    ? `\n\nAvailable sources:\n${args.sourceCards.slice(0, 4).map((card) => `- ${clipText(card.title || card.url, 80)} | ${card.url}`).join("\n")}`
    : "";
  const contextBlock = args.contextSnippets.length > 0
    ? `\n\nContext highlights:\n${args.contextSnippets.slice(0, 4).map((item) => `- ${clipText(item, 180)}`).join("\n")}`
    : "";
  return {
    title: `Draft unavailable: ${deriveTitle(args.instruction)}`,
    content: clipWords([
      "Full draft generation did not complete in this run.",
      `Reason: ${args.reason}.`,
      `Requested format: ${args.format}; tone: ${args.tone}; audience: ${args.audience}.`,
      "Retry writer_agent when more time or source coverage is available.",
      contextBlock,
      sourceBlock
    ].join("\n"), Math.min(args.maxWords, 220)),
    summary: "Draft generation deferred due to model or budget failure.",
    nextSteps: ["Retry generation", "Verify source coverage", "Adjust tone if needed"]
  };
}

function extractSourceIdsFromContent(content: string, maxId: number): number[] {
  const ids = new Set<number>();
  const regex = /\[S(\d{1,2})\]/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 1 && value <= maxId) {
      ids.add(value);
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

function buildReferencesBlock(sourceIndex: SourceIndexEntry[], sourceIds: number[], heading: string): string {
  const ids = sourceIds.length > 0 ? sourceIds : sourceIndex.slice(0, 8).map((item) => item.id);
  const lines = ids
    .map((id) => sourceIndex.find((entry) => entry.id === id))
    .filter((item): item is SourceIndexEntry => Boolean(item))
    .map((entry) => `[S${entry.id}] ${entry.title} — ${entry.url}`);
  if (lines.length === 0) {
    return "";
  }
  return `\n\n## ${heading}\n${lines.join("\n")}`;
}

function ensureReferencesSection(content: string, sourceIndex: SourceIndexEntry[], heading: string): string {
  const normalized = content.trim();
  if (!normalized || sourceIndex.length === 0) {
    return normalized;
  }
  if (/\breferences\b/i.test(normalized)) {
    return normalized;
  }
  const sourceIds = extractSourceIdsFromContent(normalized, sourceIndex.length);
  const references = buildReferencesBlock(sourceIndex, sourceIds, heading);
  return references ? `${normalized}${references}`.trim() : normalized;
}

function detectProcessCommentary(content: string): boolean {
  const normalized = content.toLowerCase();
  return [
    "selection process",
    "i reviewed the evidence",
    "i would next",
    "would next verify",
    "need more research",
    "before assembling",
    "planning memo",
    "evidence inventory"
  ].some((phrase) => normalized.includes(phrase));
}

function evaluateMechanicalQuality(args: {
  content: string;
  maxWords: number;
  outputShape: WriterOutputShape;
  shouldIncludeReferences: boolean;
  sourceIndex: SourceIndexEntry[];
}): { wordCount: number; citationCount: number; deliverableStatus: WriterDeliverableStatus; processCommentaryDetected: boolean; missing: string[] } {
  const content = args.content.trim();
  const wordCount = countWords(content);
  const citationCount = (content.match(/\[S\d+\]/g) ?? []).length;
  const processCommentaryDetected = detectProcessCommentary(content);
  const missing: string[] = [];
  const minWords = (() => {
    switch (args.outputShape) {
      case "social_post":
        return Math.max(40, Math.round(args.maxWords * 0.3));
      case "outline":
      case "notes":
      case "brief":
      case "ranked_list":
      case "comparison":
      case "list":
      case "table":
        return Math.max(60, Math.round(args.maxWords * 0.2));
      default:
        return Math.max(120, Math.round(args.maxWords * 0.4));
    }
  })();
  if (wordCount < minWords) {
    missing.push(`Word count below target (${wordCount}/${minWords}+)`);
  }
  if (args.shouldIncludeReferences && args.sourceIndex.length > 0) {
    const minCitations = Math.min(3, Math.max(1, args.sourceIndex.length));
    if (citationCount < minCitations) {
      missing.push(`Too few citation markers (${citationCount}/${minCitations}+)`);
    }
    if (!/\breferences\b/i.test(content)) {
      missing.push("References section missing.");
    }
  }
  if (processCommentaryDetected) {
    missing.push("Process commentary detected.");
  }
  let deliverableStatus: WriterDeliverableStatus = "complete";
  if (missing.length > 0) {
    deliverableStatus = wordCount >= Math.max(90, Math.round(minWords * 0.7)) && !processCommentaryDetected ? "partial" : "insufficient";
  }
  return { wordCount, citationCount, deliverableStatus, processCommentaryDetected, missing };
}

function shouldPersistGeneratedDraft(args: {
  explicitOutputPath: boolean;
  draftQuality: "complete" | "placeholder";
  deliverableStatus: WriterDeliverableStatus;
  processCommentaryDetected: boolean;
  wordCount: number;
  fallbackReason: string;
  failureMessage: string | null;
}): boolean {
  if (args.draftQuality === "complete") {
    return true;
  }
  if (args.deliverableStatus !== "partial") {
    return false;
  }
  if (args.processCommentaryDetected) {
    return false;
  }
  const normalizedFailure = (args.failureMessage ?? "").toLowerCase();
  if (
    args.fallbackReason === "missing_api_key"
    || normalizedFailure.includes("timeout")
    || normalizedFailure.includes("network")
  ) {
    return false;
  }
  return args.explicitOutputPath && args.wordCount >= 140;
}

function buildWriterPrompt(args: {
  instruction: string;
  outputShape: WriterOutputShape;
  format: WriterFormat;
  tone: string;
  audience: string;
  maxWords: number;
  shouldIncludeReferences: boolean;
  sourceIndex: SourceIndexEntry[];
  contextSnippets: string[];
}): string {
  return [
    `Instruction: ${args.instruction}`,
    `Deliverable shape: ${args.outputShape}`,
    `Format hint: ${args.format}`,
    `Tone: ${args.tone}`,
    `Audience: ${args.audience}`,
    `Maximum words: ${args.maxWords}`,
    args.shouldIncludeReferences && args.sourceIndex.length > 0
      ? "Use [S#] citation markers for factual claims and end with a References section."
      : "Stay grounded in the supplied evidence and note uncertainty inline when needed.",
    "Produce only the final deliverable body. Do not explain your process, do not output a planning memo, and do not ask follow-up questions.",
    formatSourceIndexForPrompt(args.sourceIndex),
    formatContextSnippets(args.contextSnippets)
  ].join("\n\n");
}

export const toolDefinition: LeadAgentToolDefinition = {
  name: "writer_agent",
  description: "Generate a user-facing draft from the current contract and evidence, then optionally persist it.",
  inputSchema: WriterAgentToolInputSchema,
  inputHint: "{\"instruction\":\"Write the final deliverable\",\"format\":\"notes\",\"outputShapeHint\":\"ranked_list\",\"maxWords\":800}",
  async execute(rawInput, context) {
    const input = WriterAgentToolInputSchema.parse(rawInput);
    const format = normalizeWriterFormat(input.format);
    const outputShape: WriterOutputShape = input.outputShapeHint ?? defaultShapeForFormat(format);
    const tone = input.tone ?? "clear and grounded";
    const audience = input.audience ?? "general";
    const maxWords = clampInt(input.maxWords ?? 900, 80, 3000);
    const contextSnippets = await loadContextSnippets(context.projectRoot, input.contextPaths);
    const sourceCards = context.getResearchSourceCards ? (context.getResearchSourceCards() ?? []) : [];
    const sourceIndex = buildSourceIndex(sourceCards);
    const shouldIncludeReferences = sourceIndex.length > 0;
    const providers = resolveWriterProviders(context);

    let draft = buildFallbackDraft({
      reason: "writer_not_completed",
      instruction: input.instruction,
      format,
      audience,
      tone,
      maxWords,
      contextSnippets,
      sourceCards
    });
    let fallbackUsed = true;
    let fallbackReason = providers.length > 0 ? "writer_not_completed" : "missing_api_key";
    let failureMessage: string | null = providers.length > 0 ? "Draft generation did not complete." : "No writer LLM provider is configured for this run.";
    let draftQuality: "complete" | "placeholder" = "placeholder";
    let deliverableStatus: WriterDeliverableStatus = "insufficient";
    let processCommentaryDetected = false;
    let providerUsed: string | null = null;
    let passCount = 0;

    const budget = computePassBudget({
      deadlineAtMs: context.deadlineAtMs,
      reserveMs: WRITER_RESERVED_TIME_MS,
      maxTimeoutMs: GENERATION_TIMEOUT_MS,
      minTimeoutMs: GENERATION_MIN_TIMEOUT_MS,
      maxAttempts: GENERATION_MAX_ATTEMPTS
    });

    if (providers.length > 0 && budget.enabled) {
      const prompt = buildWriterPrompt({
        instruction: input.instruction,
        outputShape,
        format,
        tone,
        audience,
        maxWords,
        shouldIncludeReferences,
        sourceIndex,
        contextSnippets
      });
      const messages = [
        {
          role: "system" as const,
          content: "You are a writing tool. Produce only the final requested deliverable body, with no planning commentary."
        },
        {
          role: "user" as const,
          content: prompt
        }
      ];
      const promptChars = countMessageChars(messages);
      await emitWriterStageEvent({
        context,
        stage: "generate",
        status: "started",
        payload: {
          timeoutMs: budget.timeoutMs,
          maxAttempts: budget.maxAttempts,
          remainingMs: budget.remainingMs,
          promptChars,
          outputShape
        }
      });

      const result = await runTextWithFallback({
        providers,
        request: {
          timeoutMs: budget.timeoutMs,
          maxAttempts: budget.maxAttempts,
          messages
        }
      });
      await maybeRecordUsage(context, result.usage);
      passCount = 1;

      if (result.content && countWords(result.content) >= 20) {
        providerUsed = result.providerUsed ?? result.provider;
        const content = clipWords(
          shouldIncludeReferences ? ensureReferencesSection(result.content, sourceIndex, "References") : result.content,
          maxWords
        );
        draft = {
          title: deriveTitleFromContent(content),
          content,
          summary: `Generated ${outputShape} deliverable.`,
          nextSteps: ["Verify factual claims", "Adjust style if needed", "Publish or share"]
        };
        
        const currentWordCount = countWords(content);
        const minWords = Math.max(60, Math.round(maxWords * 0.3));
        processCommentaryDetected = detectProcessCommentary(content);
        
        if (currentWordCount >= minWords && !processCommentaryDetected) {
          draftQuality = "complete";
          deliverableStatus = "complete";
          fallbackUsed = false;
          fallbackReason = "none";
          failureMessage = null;
        } else {
          draftQuality = "placeholder";
          deliverableStatus = currentWordCount >= 40 ? "partial" : "insufficient";
          fallbackReason = processCommentaryDetected ? "process_commentary_detected" : "draft_too_short";
          failureMessage = processCommentaryDetected 
            ? "Generated content contains process commentary instead of the deliverable." 
            : `Draft is too short (${currentWordCount}/${minWords} words).`;
        }

        await emitWriterStageEvent({
          context,
          stage: "generate",
          status: draftQuality === "complete" ? "completed" : "failed",
          payload: {
            provider: providerUsed,
            wordCount: currentWordCount,
            draftQuality,
            deliverableStatus,
            outputShape,
            processCommentaryDetected,
            fallbackReason,
            failureMessage,
            ...llmTimingPayload(result)
          }
        });
      } else {
        fallbackReason = result.failureCode ?? "writer_generate_failed";
        failureMessage = result.failureMessage ?? failureMessage;
        await emitWriterStageEvent({
          context,
          stage: "generate",
          status: "failed",
          payload: {
            failureCode: result.failureCode ?? "empty_or_short_response",
            failureClass: result.failureClass ?? "unknown",
            failureMessage: result.failureMessage ?? null,
            outputShape,
            ...llmTimingPayload(result)
          }
        });
        
        // If it really failed to get anything, we should return an error result
        if (!result.content || countWords(result.content) < 5) {
           throw new Error(failureMessage || "Writer failed to generate content.");
        }
      }
    } else {
      await emitWriterStageEvent({
        context,
        stage: "generate",
        status: "skipped",
        payload: {
          reason: providers.length === 0 ? "missing_api_key" : (budget.skipReason ?? "insufficient_deadline_budget"),
          remainingMs: budget.remainingMs,
          outputShape
        }
      });
    }

    let writtenPath: string | null = null;
    let didWriteDraft = false;
    const finalWordCount = countWords(draft.content);
    const shouldPersistDraft = shouldPersistGeneratedDraft({
      explicitOutputPath: Boolean(input.outputPath),
      draftQuality,
      deliverableStatus,
      processCommentaryDetected,
      wordCount: finalWordCount,
      fallbackReason,
      failureMessage
    });
    const resolvedOutputPath = shouldPersistDraft
      ? (input.outputPath ?? buildDefaultSessionOutputPath({ sessionId: context.sessionId, runId: context.runId, format }))
      : input.outputPath;

    if (resolvedOutputPath && shouldPersistDraft) {
      await emitWriterStageEvent({
        context,
        stage: "persist",
        status: "started",
        payload: {
          outputPath: resolvedOutputPath,
          draftQuality,
          deliverableStatus,
          autoSelectedOutputPath: !input.outputPath
        }
      });
      try {
        const absoluteOutput = resolvePathInProject(context.projectRoot, resolvedOutputPath);
        await mkdir(path.dirname(absoluteOutput), { recursive: true });
        const relativeOutputPath = toProjectRelative(context.projectRoot, absoluteOutput);
        const shouldOverwrite = input.overwrite !== false;
        let existingContent: string | null = null;
        try {
          existingContent = await readFile(absoluteOutput, "utf8");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        if (!shouldOverwrite && existingContent !== null) {
          throw new Error("output file already exists and overwrite=false");
        }
        if (draftQuality !== "complete" && typeof existingContent === "string" && existingContent.trim().length > 0) {
          const existingQuality = evaluateMechanicalQuality({
            content: existingContent,
            maxWords,
            outputShape,
            shouldIncludeReferences,
            sourceIndex
          });
          if (existingQuality.deliverableStatus === "complete") {
            writtenPath = relativeOutputPath;
            draft = {
              title: deriveTitleFromContent(existingContent),
              content: existingContent.trim(),
              summary: "Preserved existing complete draft at output path.",
              nextSteps: ["Review factual claims", "Adjust style if needed", "Publish or share"]
            };
            draftQuality = "complete";
            fallbackUsed = false;
            fallbackReason = "none";
            failureMessage = null;
            deliverableStatus = "complete";
            processCommentaryDetected = false;
            context.addArtifact(writtenPath);
            await emitWriterStageEvent({
              context,
              stage: "persist",
              status: "skipped",
              payload: {
                outputPath: writtenPath,
                reason: "quality_downgrade_prevented"
              }
            });
            return {
              title: draft.title,
              content: draft.content,
              summary: draft.summary,
              nextSteps: draft.nextSteps,
              format,
              tone,
              audience,
              wordCount: countWords(draft.content),
              contextSnippetCount: contextSnippets.length,
              sourceCardCount: sourceCards.length,
              fallbackUsed,
              fallbackReason,
              failureMessage,
              draftQuality,
              deliverableStatus,
              outputShape,
              processCommentaryDetected,
              providerUsed,
              passCount,
              persistedFallbackDraft: false,
              outputPath: writtenPath
            };
          }
        }
        await writeFile(absoluteOutput, `${draft.title}\n\n${draft.content}\n`, "utf8");
        didWriteDraft = true;
        writtenPath = relativeOutputPath;
        context.addArtifact(writtenPath);
        await emitWriterStageEvent({
          context,
          stage: "persist",
          status: "completed",
          payload: {
            outputPath: writtenPath,
            wordCount: finalWordCount,
            draftQuality,
            deliverableStatus
          }
        });
      } catch (error) {
        await emitWriterStageEvent({
          context,
          stage: "persist",
          status: "failed",
          payload: {
            outputPath: resolvedOutputPath,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    } else if (resolvedOutputPath) {
      await emitWriterStageEvent({
        context,
        stage: "persist",
        status: "skipped",
        payload: {
          outputPath: resolvedOutputPath,
          reason: draftQuality !== "complete" ? "placeholder_persist_blocked" : "draft_not_writable",
          draftQuality,
          deliverableStatus,
          wordCount: finalWordCount,
          autoSelectedOutputPath: !input.outputPath,
          fallbackReason,
          failureMessage,
          processCommentaryDetected
        }
      });
    }

    return {
      title: draft.title,
      content: draft.content,
      summary: draft.summary,
      nextSteps: draft.nextSteps,
      format,
      tone,
      audience,
      wordCount: countWords(draft.content),
      contextSnippetCount: contextSnippets.length,
      sourceCardCount: sourceCards.length,
      fallbackUsed,
      fallbackReason,
      failureMessage,
      draftQuality,
      deliverableStatus,
      outputShape,
      processCommentaryDetected,
      providerUsed,
      passCount,
      persistedFallbackDraft: didWriteDraft && draftQuality !== "complete",
      outputPath: writtenPath
    };
  }
};
