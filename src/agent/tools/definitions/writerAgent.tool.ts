import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmUsage } from "../../../types.js";
import type { LeadAgentToolDefinition, ResearchSourceCard } from "../../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";
import { OpenAiLlmProvider } from "../../../services/llm/openAiProvider.js";
import { runStructuredWithFallback, runTextWithFallback } from "../../../services/llm/router.js";
import type { LlmProvider } from "../../../services/llm/types.js";

const WriterAgentToolInputSchema = z.object({
  instruction: z.string().min(8).max(3000),
  format: z.enum(["blog_post", "email", "memo", "outline", "social_post", "notes"]).optional(),
  audience: z.string().min(2).max(120).optional(),
  tone: z.string().min(2).max(120).optional(),
  maxWords: z.number().int().min(80).max(3000).optional(),
  contextPaths: z.array(z.string().min(1).max(600)).max(8).optional(),
  outputPath: z.string().min(1).max(600).optional(),
  overwrite: z.boolean().optional()
});

const WRITER_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    content: { type: "string", minLength: 1, maxLength: 12000 },
    summary: { type: "string", minLength: 1, maxLength: 800 },
    nextSteps: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 200 }
    }
  },
  required: ["title", "content", "summary", "nextSteps"]
} as const;

const WriterResponseSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(12000),
  summary: z.string().min(1).max(800),
  nextSteps: z.array(z.string().min(1).max(200)).max(6)
});

const WriterIntentSchema = z.object({
  outputShape: z.enum(["article", "ranked_list", "comparison", "brief", "memo", "email", "outline", "social_post", "notes", "rewrite", "generic"]),
  titleHint: z.string().min(3).max(180),
  deliverableSummary: z.string().min(10).max(260),
  targetItemCount: z.number().int().min(1).max(50).nullable().optional(),
  requiredElements: z.array(z.string().min(2).max(180)).max(8),
  formattingDirectives: z.array(z.string().min(2).max(180)).max(8),
  shouldIncludeReferences: z.boolean().default(true),
  shouldUseHeadings: z.boolean().default(true),
  shouldPreserveExistingStructure: z.boolean().default(false)
});

const WriterReviewSchema = z.object({
  deliverableStatus: z.enum(["complete", "partial", "insufficient"]),
  matchesRequestedShape: z.boolean(),
  processCommentaryDetected: z.boolean(),
  shouldPersist: z.boolean(),
  missingRequirements: z.array(z.string().min(1).max(180)).max(8),
  repairFocus: z.array(z.string().min(1).max(180)).max(6),
  summary: z.string().min(1).max(400)
});

const MAX_SOURCE_CARDS_FOR_PROMPT = 14;
const WRITER_RESERVED_TIME_MS = 10_000;
const INTENT_PASS_MAX_TIMEOUT_MS = 25_000;
const DRAFT_PASS_MAX_TIMEOUT_MS = 55_000;
const REVIEW_PASS_MAX_TIMEOUT_MS = 25_000;
const REPAIR_PASS_MAX_TIMEOUT_MS = 45_000;
const DIRECT_RETRY_MAX_TIMEOUT_MS = 35_000;
const INTENT_PASS_MAX_ATTEMPTS = 2;
const DRAFT_PASS_MAX_ATTEMPTS = 2;
const REVIEW_PASS_MAX_ATTEMPTS = 2;
const REPAIR_PASS_MAX_ATTEMPTS = 2;
const DIRECT_RETRY_MAX_ATTEMPTS = 2;

type WriterFormat = "blog_post" | "email" | "memo" | "outline" | "social_post" | "notes";
type WriterIntent = z.infer<typeof WriterIntentSchema>;
type WriterReview = z.infer<typeof WriterReviewSchema>;
type WriterDeliverableStatus = WriterReview["deliverableStatus"];

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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function clipWords(text: string, maxWords: number): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= maxWords) {
    return text.trim();
  }
  return `${parts.slice(0, maxWords).join(" ").trim()}`;
}

function clipText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trim()}…`;
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

function deriveTitle(instruction: string): string {
  const trimmed = instruction.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "Draft";
  }
  return clipText(trimmed, 80);
}

function buildDefaultSessionOutputPath(args: {
  sessionId: string;
  runId: string;
  format: WriterFormat;
}): string {
  const suffix = args.format === "blog_post" ? "article" : args.format;
  return path.posix.join("workspace", "alfred", "sessions", args.sessionId, "outputs", `${args.runId}-${suffix}.md`);
}

function normalizeWriterFormat(value: unknown): WriterFormat {
  if (typeof value !== "string") {
    return "blog_post";
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  switch (normalized) {
    case "blog":
    case "blogpost":
    case "blog_post":
    case "blog_article":
    case "article":
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

function defaultShapeForFormat(format: WriterFormat): WriterIntent["outputShape"] {
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

function nowIso(): string {
  return new Date().toISOString();
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

function sourceCardBullets(cards: ResearchSourceCard[], max = 8): string[] {
  return cards.slice(0, max).map((card, index) => {
    const title = card.title ? clipText(card.title, 70) : "Untitled source";
    const claim = card.claim ? ` | key point: ${clipText(card.claim, 120)}` : "";
    return `[${index + 1}] ${title} | ${card.url}${claim}`;
  });
}

function buildSourceIndex(cards: ResearchSourceCard[]): SourceIndexEntry[] {
  return cards.slice(0, MAX_SOURCE_CARDS_FOR_PROMPT).map((card, index) => ({
    id: index + 1,
    url: card.url,
    title: card.title ? clipText(card.title, 90) : "Untitled source",
    claim: clipText(card.claim || "No claim extracted.", 180)
  }));
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
  const heading = `Draft unavailable: ${deriveTitle(args.instruction)}`;
  const sourceLines = sourceCardBullets(args.sourceCards);
  const contextBlock =
    args.contextSnippets.length > 0
      ? `\n\nContext highlights:\n${args.contextSnippets.slice(0, 4).map((item) => `- ${clipText(item, 180)}`).join("\n")}`
      : "";
  const sourceBlock =
    sourceLines.length > 0
      ? `\n\nAvailable sources:\n${sourceLines.map((line) => `- ${line}`).join("\n")}`
      : "";
  const content = clipWords(
    [
      "Full draft generation did not complete in this run.",
      `Reason: ${args.reason}.`,
      `Requested format: ${args.format}; tone: ${args.tone}; audience: ${args.audience}.`,
      "",
      "What to do next:",
      "1. Retry writer_agent to generate the full draft.",
      "2. Add more accessible sources if paywalls/blocks are limiting content.",
      contextBlock,
      sourceBlock
    ].join("\n"),
    Math.min(args.maxWords, 220)
  );
  return {
    title: heading,
    content,
    summary: "Draft generation deferred due to model/network failure.",
    nextSteps: ["Review factual accuracy", "Refine messaging and tone", "Publish or share after edits"]
  };
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
  const ids = sourceIds.length > 0
    ? sourceIds
    : sourceIndex.slice(0, 8).map((item) => item.id);
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
  if (!normalized) {
    return normalized;
  }
  if (/\breferences\b/i.test(normalized)) {
    return normalized;
  }
  const sourceIds = extractSourceIdsFromContent(normalized, sourceIndex.length);
  const references = buildReferencesBlock(sourceIndex, sourceIds, heading);
  return references ? `${normalized}${references}`.trim() : normalized;
}

function evaluateMechanicalQuality(args: {
  content: string;
  maxWords: number;
  outputShape: WriterIntent["outputShape"];
  targetItemCount?: number | null;
  shouldIncludeReferences: boolean;
  sourceIndex: SourceIndexEntry[];
}): { wordCount: number; citationCount: number; missing: string[] } {
  const wordCount = countWords(args.content);
  const citationCount = (args.content.match(/\[S\d+\]/g) ?? []).length;
  const missing: string[] = [];
  const minWords = (() => {
    switch (args.outputShape) {
      case "social_post":
        return Math.max(60, Math.round(args.maxWords * 0.4));
      case "outline":
      case "notes":
      case "brief":
      case "ranked_list":
      case "comparison":
        return Math.max(
          60,
          args.targetItemCount
            ? Math.round(args.targetItemCount * 28)
            : Math.round(args.maxWords * 0.28)
        );
      default:
        return Math.max(120, Math.round(args.maxWords * 0.45));
    }
  })();
  if (wordCount < minWords) {
    missing.push(`Word count below target (${wordCount}/${minWords}+).`);
  }
  if (args.shouldIncludeReferences && args.sourceIndex.length > 0) {
    const minCitations = Math.min(3, Math.max(1, args.sourceIndex.length));
    if (citationCount < minCitations) {
      missing.push(`Too few citation markers (${citationCount}/${minCitations}+).`);
    }
    if (!/\breferences\b/i.test(args.content)) {
      missing.push("References section missing.");
    }
  }
  return {
    wordCount,
    citationCount,
    missing
  };
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
    || normalizedFailure.includes("aborted due to timeout")
    || normalizedFailure.includes("network")
    || normalizedFailure.includes("structured")
  ) {
    return false;
  }
  return args.explicitOutputPath && args.wordCount >= 140;
}

function deriveTitleFromContent(content: string): string {
  const firstNonEmpty = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstNonEmpty) {
    return "Draft";
  }
  const normalized = firstNonEmpty.replace(/^#+\s*/, "").trim();
  return clipText(normalized || firstNonEmpty, 160);
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

function buildWriterIntentPrompt(args: {
  instruction: string;
  format: WriterFormat;
  tone: string;
  audience: string;
  maxWords: number;
  sourceIndex: SourceIndexEntry[];
  contextSnippets: string[];
}): string {
  return [
    `Instruction: ${args.instruction}`,
    `Format hint: ${args.format}`,
    `Tone: ${args.tone}`,
    `Audience: ${args.audience}`,
    `Max words: ${args.maxWords}`,
    "Infer the final deliverable shape the user actually wants. Treat the format hint as secondary when the instruction clearly asks for another deliverable shape such as a ranked list, comparison, rewrite, or brief.",
    "Do not choose a process memo, evidence inventory, section plan, or research log unless the user explicitly asked for that. Prefer the final user-facing deliverable.",
    "Choose required elements that belong in the final answer, not research steps.",
    formatSourceIndexForPrompt(args.sourceIndex),
    formatContextSnippets(args.contextSnippets)
  ].join("\n\n");
}

function buildWriterDraftPrompt(args: {
  instruction: string;
  intent: WriterIntent;
  format: WriterFormat;
  tone: string;
  audience: string;
  maxWords: number;
  sourceIndex: SourceIndexEntry[];
  contextSnippets: string[];
}): string {
  const itemCountText = args.intent.targetItemCount ? `${args.intent.targetItemCount}` : "not specified";
  const requiredElements = args.intent.requiredElements.length > 0
    ? args.intent.requiredElements.map((item) => `- ${item}`).join("\n")
    : "- none specified";
  const formattingDirectives = args.intent.formattingDirectives.length > 0
    ? args.intent.formattingDirectives.map((item) => `- ${item}`).join("\n")
    : "- none specified";
  return [
    `Instruction: ${args.instruction}`,
    `Interpreted deliverable: ${args.intent.deliverableSummary}`,
    `Output shape: ${args.intent.outputShape}`,
    `Title hint: ${args.intent.titleHint}`,
    `Format hint: ${args.format}`,
    `Tone: ${args.tone}`,
    `Audience: ${args.audience}`,
    `Max words: ${args.maxWords}`,
    `Target item count: ${itemCountText}`,
    `Required elements:\n${requiredElements}`,
    `Formatting directives:\n${formattingDirectives}`,
    args.intent.shouldIncludeReferences && args.sourceIndex.length > 0
      ? "Use [S#] citation markers for factual claims and include a References section mapping markers to URLs."
      : "Use the provided sources for factual grounding. Cite with [S#] markers when helpful.",
    "Write the final deliverable directly. Do not output planning commentary, evidence inventory, selection criteria, process notes, or what you would do next unless the user explicitly asked for that.",
    "If evidence is incomplete, keep uncertainty brief and inline inside the actual deliverable instead of replacing the deliverable with a meta memo.",
    formatSourceIndexForPrompt(args.sourceIndex),
    formatContextSnippets(args.contextSnippets)
  ].join("\n\n");
}

function buildWriterReviewPrompt(args: {
  instruction: string;
  intent: WriterIntent;
  draft: { title: string; content: string; summary: string; nextSteps: string[] };
  maxWords: number;
  sourceIndex: SourceIndexEntry[];
}): string {
  const requiredElements = args.intent.requiredElements.length > 0
    ? args.intent.requiredElements.map((item) => `- ${item}`).join("\n")
    : "- none specified";
  return [
    `Instruction: ${args.instruction}`,
    `Expected deliverable: ${args.intent.deliverableSummary}`,
    `Expected output shape: ${args.intent.outputShape}`,
    `Expected title hint: ${args.intent.titleHint}`,
    `Expected item count: ${args.intent.targetItemCount ?? "not specified"}`,
    `Required elements:\n${requiredElements}`,
    `Word budget: ${args.maxWords}`,
    args.intent.shouldIncludeReferences && args.sourceIndex.length > 0
      ? "A complete response should preserve [S#] citation markers and include a References section."
      : "A complete response should stay grounded in the provided evidence.",
    "A reusable body can be complete or partial, but it must already be in the requested deliverable shape.",
    "A planning memo, evidence inventory, section plan, research log, or 'I need more research' note is not a reusable body for the requested deliverable.",
    `Draft title: ${args.draft.title}`,
    `Draft summary: ${args.draft.summary}`,
    `Draft content:\n${args.draft.content}`
  ].join("\n\n");
}

function buildWriterRepairPrompt(args: {
  instruction: string;
  intent: WriterIntent;
  draft: { title: string; content: string; summary: string; nextSteps: string[] };
  review: WriterReview;
  format: WriterFormat;
  tone: string;
  audience: string;
  maxWords: number;
  sourceIndex: SourceIndexEntry[];
  contextSnippets: string[];
}): string {
  const missing = args.review.missingRequirements.length > 0
    ? args.review.missingRequirements.map((item) => `- ${item}`).join("\n")
    : "- none listed";
  const focus = args.review.repairFocus.length > 0
    ? args.review.repairFocus.map((item) => `- ${item}`).join("\n")
    : "- none listed";
  return [
    `Instruction: ${args.instruction}`,
    `Expected deliverable: ${args.intent.deliverableSummary}`,
    `Output shape: ${args.intent.outputShape}`,
    `Format hint: ${args.format}`,
    `Tone: ${args.tone}`,
    `Audience: ${args.audience}`,
    `Max words: ${args.maxWords}`,
    `Missing requirements:\n${missing}`,
    `Repair focus:\n${focus}`,
    "Transform the current draft into the requested final deliverable. Remove process commentary, evidence inventory, and future-work notes unless explicitly requested.",
    "Keep uncertainty concise and inline inside the deliverable where needed. Preserve factual grounding and [S#] markers.",
    formatSourceIndexForPrompt(args.sourceIndex),
    formatContextSnippets(args.contextSnippets),
    `Current draft:\n${args.draft.content}`
  ].join("\n\n");
}

function buildDirectRetryPrompt(args: {
  instruction: string;
  intent: WriterIntent | null;
  format: WriterFormat;
  tone: string;
  audience: string;
  maxWords: number;
  sourceIndex: SourceIndexEntry[];
  contextSnippets: string[];
}): string {
  return [
    `Instruction: ${args.instruction}`,
    `Output shape: ${args.intent?.outputShape ?? defaultShapeForFormat(args.format)}`,
    `Deliverable summary: ${args.intent?.deliverableSummary ?? deriveTitle(args.instruction)}`,
    `Target item count: ${args.intent?.targetItemCount ?? "not specified"}`,
    `Tone: ${args.tone}`,
    `Audience: ${args.audience}`,
    `Word limit: ${args.maxWords}`,
    args.intent?.shouldIncludeReferences && args.sourceIndex.length > 0
      ? "Use [S#] citations for factual claims and end with a References section."
      : "Stay grounded in the provided sources and note uncertainty honestly.",
    "Produce only the final deliverable body. Do not explain your process or output a planning memo.",
    formatSourceIndexForPrompt(args.sourceIndex),
    formatContextSnippets(args.contextSnippets)
  ].join("\n\n");
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
  const providers: LlmProvider[] = [];
  if (context.openAiApiKey) {
    providers.push(new OpenAiLlmProvider({
      apiKey: context.openAiApiKey
    }));
  }
  return providers;
}

export const toolDefinition: LeadAgentToolDefinition<typeof WriterAgentToolInputSchema> = {
  name: "writer_agent",
  description: "Generate structured written drafts (blog/email/memo/etc.) from instructions and optional local context.",
  inputSchema: WriterAgentToolInputSchema,
  inputHint: "Use for drafting content quickly; set outputPath to save draft to a file.",
  async execute(input, context) {
    const format = normalizeWriterFormat(input.format);
    const tone = input.tone ?? "clear and practical";
    const audience = input.audience ?? "general technical audience";
    const maxWords = input.maxWords ?? 700;
    const contextSnippets = await loadContextSnippets(context.projectRoot, input.contextPaths);
    const sourceCards = (context.getResearchSourceCards?.() ?? context.state.researchSourceCards ?? []).slice(-MAX_SOURCE_CARDS_FOR_PROMPT);
    const sourceIndex = buildSourceIndex(sourceCards);
    const providers = resolveWriterProviders(context);
    const hasSynthesisMaterial = sourceIndex.length > 0 || contextSnippets.length > 0;

    let draft = buildFallbackDraft({
      reason: "Draft generation did not complete.",
      instruction: input.instruction,
      format,
      audience,
      tone,
      maxWords,
      contextSnippets,
      sourceCards
    });
    let intent: WriterIntent | null = null;
    let review: WriterReview | null = null;
    let fallbackUsed = true;
    let fallbackReason = "writer_not_completed";
    let failureMessage: string | null = null;
    let draftQuality: "complete" | "placeholder" = "placeholder";
    let deliverableStatus: WriterDeliverableStatus = "insufficient";
    let outputShape: WriterIntent["outputShape"] = defaultShapeForFormat(format);
    let processCommentaryDetected = false;
    let providerUsed: string | null = null;
    let passCount = 0;

    if (!hasSynthesisMaterial) {
      fallbackReason = "insufficient_source_material";
      failureMessage = "No research source cards or context snippets were provided for synthesis.";
      draft = buildFallbackDraft({
        reason: failureMessage,
        instruction: input.instruction,
        format,
        audience,
        tone,
        maxWords,
        contextSnippets,
        sourceCards
      });
      await emitWriterStageEvent({
        context,
        stage: "structured_attempt",
        status: "skipped",
        payload: {
          reason: "insufficient_source_material",
          sourceCardCount: sourceCards.length,
          contextSnippetCount: contextSnippets.length
        }
      });
    } else if (providers.length > 0) {
      await emitWriterStageEvent({
        context,
        stage: "structured_attempt",
        status: "started",
        payload: {
          maxWords,
          format,
          hasOutputPath: Boolean(input.outputPath),
          sourceCardCount: sourceCards.length,
          contextSnippetCount: contextSnippets.length,
          providerCount: providers.length
        }
      });

      const intentBudget = computePassBudget({
        deadlineAtMs: context.deadlineAtMs,
        reserveMs: WRITER_RESERVED_TIME_MS,
        maxTimeoutMs: INTENT_PASS_MAX_TIMEOUT_MS,
        minTimeoutMs: 7_000,
        maxAttempts: INTENT_PASS_MAX_ATTEMPTS
      });

      if (intentBudget.enabled) {
        const intentPrompt = buildWriterIntentPrompt({
          instruction: input.instruction,
          format,
          tone,
          audience,
          maxWords,
          sourceIndex,
          contextSnippets
        });
        const intentMessages = [
          {
            role: "system" as const,
            content: "You are a deliverable strategist. Infer the final user-facing output shape and constraints. Return strict JSON only."
          },
          {
            role: "user" as const,
            content: intentPrompt
          }
        ];
        const intentPromptChars = countMessageChars(intentMessages);
        await emitWriterStageEvent({
          context,
          stage: "intent_pass",
          status: "started",
          payload: {
            timeoutMs: intentBudget.timeoutMs,
            maxAttempts: intentBudget.maxAttempts,
            remainingMs: intentBudget.remainingMs,
            promptChars: intentPromptChars
          }
        });

        const intentResult = await runStructuredWithFallback({
          providers,
          request: {
            schemaName: "writer_intent_v1",
            jsonSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                outputShape: { type: "string", enum: ["article", "ranked_list", "comparison", "brief", "memo", "email", "outline", "social_post", "notes", "rewrite", "generic"] },
                titleHint: { type: "string", minLength: 3, maxLength: 180 },
                deliverableSummary: { type: "string", minLength: 10, maxLength: 260 },
                targetItemCount: { anyOf: [{ type: "integer", minimum: 1, maximum: 50 }, { type: "null" }] },
                requiredElements: {
                  type: "array",
                  maxItems: 8,
                  items: { type: "string", minLength: 2, maxLength: 180 }
                },
                formattingDirectives: {
                  type: "array",
                  maxItems: 8,
                  items: { type: "string", minLength: 2, maxLength: 180 }
                },
                shouldIncludeReferences: { type: "boolean" },
                shouldUseHeadings: { type: "boolean" },
                shouldPreserveExistingStructure: { type: "boolean" }
              },
              required: [
                "outputShape",
                "titleHint",
                "deliverableSummary",
                "targetItemCount",
                "requiredElements",
                "formattingDirectives",
                "shouldIncludeReferences",
                "shouldUseHeadings",
                "shouldPreserveExistingStructure"
              ]
            },
            timeoutMs: intentBudget.timeoutMs,
            maxAttempts: intentBudget.maxAttempts,
            messages: intentMessages
          },
          validator: WriterIntentSchema
        });
        await maybeRecordUsage(context, intentResult.usage);
        passCount += 1;

        if (intentResult.result) {
          intent = intentResult.result;
          outputShape = intent.outputShape;
          providerUsed = intentResult.providerUsed ?? intentResult.provider;
          await emitWriterStageEvent({
            context,
            stage: "intent_pass",
            status: "completed",
            payload: {
              provider: providerUsed,
              outputShape: intent.outputShape,
              targetItemCount: intent.targetItemCount ?? null,
              providerAttempts: intentResult.providerAttempts,
              timeoutMs: intentBudget.timeoutMs,
              promptChars: intentPromptChars,
              ...llmTimingPayload(intentResult)
            }
          });
        } else {
          fallbackReason = intentResult.failureCode ?? "intent_pass_failed";
          failureMessage = intentResult.failureMessage ?? "Intent pass failed";
          await emitWriterStageEvent({
            context,
            stage: "intent_pass",
            status: "failed",
            payload: {
              failureCode: intentResult.failureCode ?? "unknown",
              failureClass: intentResult.failureClass ?? "unknown",
              failureMessage: intentResult.failureMessage ?? null,
              providerAttempts: intentResult.providerAttempts,
              timeoutMs: intentBudget.timeoutMs,
              promptChars: intentPromptChars,
              ...llmTimingPayload(intentResult)
            }
          });
        }
      } else {
        fallbackReason = "intent_pass_skipped";
        failureMessage = `Intent pass skipped due to low remaining budget (${intentBudget.remainingMs}ms)`;
        await emitWriterStageEvent({
          context,
          stage: "intent_pass",
          status: "skipped",
          payload: {
            reason: intentBudget.skipReason ?? "insufficient_deadline_budget",
            remainingMs: intentBudget.remainingMs
          }
        });
      }

      if (intent) {
        const draftBudget = computePassBudget({
          deadlineAtMs: context.deadlineAtMs,
          reserveMs: WRITER_RESERVED_TIME_MS,
          maxTimeoutMs: DRAFT_PASS_MAX_TIMEOUT_MS,
          minTimeoutMs: 8_000,
          maxAttempts: DRAFT_PASS_MAX_ATTEMPTS
        });

        if (draftBudget.enabled) {
          const draftPrompt = buildWriterDraftPrompt({
            instruction: input.instruction,
            intent,
            format,
            tone,
            audience,
            maxWords,
            sourceIndex,
            contextSnippets
          });
          const draftMessages = [
            {
              role: "system" as const,
              content: "You are a grounded writer. Produce the final user-facing deliverable in the requested shape. Return strict JSON only."
            },
            {
              role: "user" as const,
              content: draftPrompt
            }
          ];
          const draftPromptChars = countMessageChars(draftMessages);
          await emitWriterStageEvent({
            context,
            stage: "draft_pass",
            status: "started",
            payload: {
              timeoutMs: draftBudget.timeoutMs,
              maxAttempts: draftBudget.maxAttempts,
              remainingMs: draftBudget.remainingMs,
              promptChars: draftPromptChars,
              outputShape: intent.outputShape
            }
          });

          const draftResult = await runStructuredWithFallback({
            providers,
            request: {
              schemaName: "writer_draft_v1",
              jsonSchema: WRITER_RESPONSE_JSON_SCHEMA,
              timeoutMs: draftBudget.timeoutMs,
              maxAttempts: draftBudget.maxAttempts,
              messages: draftMessages
            },
            validator: WriterResponseSchema
          });
          await maybeRecordUsage(context, draftResult.usage);
          passCount += 1;

          if (draftResult.result) {
            providerUsed = providerUsed ?? draftResult.providerUsed ?? draftResult.provider;
            draft = {
              ...draftResult.result,
              content: clipWords(draftResult.result.content, maxWords)
            };
            await emitWriterStageEvent({
              context,
              stage: "draft_pass",
              status: "completed",
              payload: {
                provider: draftResult.providerUsed ?? draftResult.provider,
                wordCount: countWords(draft.content),
                providerAttempts: draftResult.providerAttempts,
                timeoutMs: draftBudget.timeoutMs,
                promptChars: draftPromptChars,
                outputShape: intent.outputShape,
                ...llmTimingPayload(draftResult)
              }
            });
          } else {
            fallbackReason = draftResult.failureCode ?? "draft_pass_failed";
            failureMessage = draftResult.failureMessage ?? "Draft pass failed";
            await emitWriterStageEvent({
              context,
              stage: "draft_pass",
              status: "failed",
              payload: {
                failureCode: draftResult.failureCode ?? "unknown",
                failureClass: draftResult.failureClass ?? "unknown",
                failureMessage: draftResult.failureMessage ?? null,
                providerAttempts: draftResult.providerAttempts,
                timeoutMs: draftBudget.timeoutMs,
                promptChars: draftPromptChars,
                outputShape: intent.outputShape,
                ...llmTimingPayload(draftResult)
              }
            });
          }
        } else {
          fallbackReason = "draft_pass_skipped";
          failureMessage = `Draft pass skipped due to low remaining budget (${draftBudget.remainingMs}ms)`;
          await emitWriterStageEvent({
            context,
            stage: "draft_pass",
            status: "skipped",
            payload: {
              reason: draftBudget.skipReason ?? "insufficient_deadline_budget",
              remainingMs: draftBudget.remainingMs,
              outputShape: intent.outputShape
            }
          });
        }
      }

      if (intent && draft.content.trim().length > 0) {
        const currentIntent = intent;
        const reviewBudget = computePassBudget({
          deadlineAtMs: context.deadlineAtMs,
          reserveMs: WRITER_RESERVED_TIME_MS,
          maxTimeoutMs: REVIEW_PASS_MAX_TIMEOUT_MS,
          minTimeoutMs: 6_500,
          maxAttempts: REVIEW_PASS_MAX_ATTEMPTS
        });

        const runReviewPass = async (stage: "review_pass" | "repair_review_pass", currentDraft: typeof draft): Promise<WriterReview | null> => {
          if (!reviewBudget.enabled) {
            await emitWriterStageEvent({
              context,
              stage,
              status: "skipped",
              payload: {
                reason: reviewBudget.skipReason ?? "insufficient_deadline_budget",
                remainingMs: reviewBudget.remainingMs,
                outputShape: intent?.outputShape ?? outputShape
              }
            });
            return null;
          }
          const reviewPrompt = buildWriterReviewPrompt({
            instruction: input.instruction,
            intent: currentIntent,
            draft: currentDraft,
            maxWords,
            sourceIndex
          });
          const reviewMessages = [
            {
              role: "system" as const,
              content: "You are a writing evaluator. Judge whether the draft is the requested deliverable or just process commentary. Return strict JSON only."
            },
            {
              role: "user" as const,
              content: reviewPrompt
            }
          ];
          const reviewPromptChars = countMessageChars(reviewMessages);
          await emitWriterStageEvent({
            context,
            stage,
            status: "started",
            payload: {
              timeoutMs: reviewBudget.timeoutMs,
              maxAttempts: reviewBudget.maxAttempts,
              remainingMs: reviewBudget.remainingMs,
              promptChars: reviewPromptChars,
              outputShape: currentIntent.outputShape
            }
          });
          const reviewResult = await runStructuredWithFallback({
            providers,
            request: {
              schemaName: "writer_review_v1",
              jsonSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  deliverableStatus: { type: "string", enum: ["complete", "partial", "insufficient"] },
                  matchesRequestedShape: { type: "boolean" },
                  processCommentaryDetected: { type: "boolean" },
                  shouldPersist: { type: "boolean" },
                  missingRequirements: {
                    type: "array",
                    maxItems: 8,
                    items: { type: "string", minLength: 1, maxLength: 180 }
                  },
                  repairFocus: {
                    type: "array",
                    maxItems: 6,
                    items: { type: "string", minLength: 1, maxLength: 180 }
                  },
                  summary: { type: "string", minLength: 1, maxLength: 400 }
                },
                required: [
                  "deliverableStatus",
                  "matchesRequestedShape",
                  "processCommentaryDetected",
                  "shouldPersist",
                  "missingRequirements",
                  "repairFocus",
                  "summary"
                ]
              },
              timeoutMs: reviewBudget.timeoutMs,
              maxAttempts: reviewBudget.maxAttempts,
              messages: reviewMessages
            },
            validator: WriterReviewSchema
          });
          await maybeRecordUsage(context, reviewResult.usage);
          passCount += 1;
          if (reviewResult.result) {
            providerUsed = providerUsed ?? reviewResult.providerUsed ?? reviewResult.provider;
            await emitWriterStageEvent({
              context,
              stage,
              status: "completed",
              payload: {
                provider: reviewResult.providerUsed ?? reviewResult.provider,
                deliverableStatus: reviewResult.result.deliverableStatus,
                matchesRequestedShape: reviewResult.result.matchesRequestedShape,
                processCommentaryDetected: reviewResult.result.processCommentaryDetected,
                shouldPersist: reviewResult.result.shouldPersist,
                timeoutMs: reviewBudget.timeoutMs,
                promptChars: reviewPromptChars,
                outputShape: currentIntent.outputShape,
                ...llmTimingPayload(reviewResult)
              }
            });
            return reviewResult.result;
          }
          await emitWriterStageEvent({
            context,
            stage,
            status: "failed",
            payload: {
              failureCode: reviewResult.failureCode ?? "unknown",
              failureClass: reviewResult.failureClass ?? "unknown",
              failureMessage: reviewResult.failureMessage ?? null,
              providerAttempts: reviewResult.providerAttempts,
              timeoutMs: reviewBudget.timeoutMs,
              promptChars: reviewPromptChars,
              outputShape: currentIntent.outputShape,
              ...llmTimingPayload(reviewResult)
            }
          });
          return null;
        };

        review = await runReviewPass("review_pass", draft);

        if (review && review.deliverableStatus !== "complete" && review.repairFocus.length > 0) {
          const repairBudget = computePassBudget({
            deadlineAtMs: context.deadlineAtMs,
            reserveMs: WRITER_RESERVED_TIME_MS,
            maxTimeoutMs: REPAIR_PASS_MAX_TIMEOUT_MS,
            minTimeoutMs: 7_000,
            maxAttempts: REPAIR_PASS_MAX_ATTEMPTS
          });

          if (repairBudget.enabled) {
            const repairPrompt = buildWriterRepairPrompt({
              instruction: input.instruction,
              intent,
              draft,
              review,
              format,
              tone,
              audience,
              maxWords,
              sourceIndex,
              contextSnippets
            });
            const repairMessages = [
              {
                role: "system" as const,
                content: "You are a revision writer. Transform the current draft into the requested final deliverable. Return strict JSON only."
              },
              {
                role: "user" as const,
                content: repairPrompt
              }
            ];
            const repairPromptChars = countMessageChars(repairMessages);
            await emitWriterStageEvent({
              context,
              stage: "repair_pass",
              status: "started",
              payload: {
                timeoutMs: repairBudget.timeoutMs,
                maxAttempts: repairBudget.maxAttempts,
                remainingMs: repairBudget.remainingMs,
                promptChars: repairPromptChars,
                outputShape: intent.outputShape,
                missingRequirements: review.missingRequirements,
                repairFocus: review.repairFocus
              }
            });

            const repairResult = await runStructuredWithFallback({
              providers,
              request: {
                schemaName: "writer_repair_v2",
                jsonSchema: WRITER_RESPONSE_JSON_SCHEMA,
                timeoutMs: repairBudget.timeoutMs,
                maxAttempts: repairBudget.maxAttempts,
                messages: repairMessages
              },
              validator: WriterResponseSchema
            });
            await maybeRecordUsage(context, repairResult.usage);
            passCount += 1;

            if (repairResult.result) {
              providerUsed = providerUsed ?? repairResult.providerUsed ?? repairResult.provider;
              draft = {
                ...repairResult.result,
                content: clipWords(repairResult.result.content, maxWords)
              };
              await emitWriterStageEvent({
                context,
                stage: "repair_pass",
                status: "completed",
                payload: {
                  provider: repairResult.providerUsed ?? repairResult.provider,
                  wordCount: countWords(draft.content),
                  providerAttempts: repairResult.providerAttempts,
                  timeoutMs: repairBudget.timeoutMs,
                  promptChars: repairPromptChars,
                  outputShape: intent.outputShape,
                  ...llmTimingPayload(repairResult)
                }
              });
              review = await runReviewPass("repair_review_pass", draft) ?? review;
            } else {
              fallbackReason = repairResult.failureCode ?? "repair_pass_failed";
              failureMessage = repairResult.failureMessage ?? failureMessage;
              await emitWriterStageEvent({
                context,
                stage: "repair_pass",
                status: "failed",
                payload: {
                  failureCode: repairResult.failureCode ?? "unknown",
                  failureClass: repairResult.failureClass ?? "unknown",
                  failureMessage: repairResult.failureMessage ?? null,
                  providerAttempts: repairResult.providerAttempts,
                  timeoutMs: repairBudget.timeoutMs,
                  promptChars: repairPromptChars,
                  outputShape: intent.outputShape,
                  ...llmTimingPayload(repairResult)
                }
              });
            }
          } else {
            await emitWriterStageEvent({
              context,
              stage: "repair_pass",
              status: "skipped",
              payload: {
                reason: repairBudget.skipReason ?? "insufficient_deadline_budget",
                remainingMs: repairBudget.remainingMs,
                outputShape: intent.outputShape
              }
            });
          }
        }
      }

      if ((!review || review.deliverableStatus === "insufficient") && providers.length > 0) {
        const retryBudget = computePassBudget({
          deadlineAtMs: context.deadlineAtMs,
          reserveMs: WRITER_RESERVED_TIME_MS,
          maxTimeoutMs: DIRECT_RETRY_MAX_TIMEOUT_MS,
          minTimeoutMs: 6_500,
          maxAttempts: DIRECT_RETRY_MAX_ATTEMPTS
        });
        if (retryBudget.enabled) {
          const retryPrompt = buildDirectRetryPrompt({
            instruction: input.instruction,
            intent,
            format,
            tone,
            audience,
            maxWords,
            sourceIndex,
            contextSnippets
          });
          const retryMessages = [
            {
              role: "system" as const,
              content: "You are a direct writing assistant. Produce only the final requested draft body."
            },
            {
              role: "user" as const,
              content: retryPrompt
            }
          ];
          const retryPromptChars = countMessageChars(retryMessages);
          await emitWriterStageEvent({
            context,
            stage: "direct_retry",
            status: "started",
            payload: {
              timeoutMs: retryBudget.timeoutMs,
              maxAttempts: retryBudget.maxAttempts,
              remainingMs: retryBudget.remainingMs,
              promptChars: retryPromptChars,
              outputShape
            }
          });

          const retryResult = await runTextWithFallback({
            providers,
            request: {
              timeoutMs: retryBudget.timeoutMs,
              maxAttempts: retryBudget.maxAttempts,
              messages: retryMessages
            }
          });
          await maybeRecordUsage(context, retryResult.usage);
          passCount += 1;

          if (retryResult.content && countWords(retryResult.content) >= 90) {
            providerUsed = providerUsed ?? retryResult.providerUsed ?? retryResult.provider;
            draft = {
              title: intent?.titleHint ?? deriveTitle(input.instruction),
              content: clipWords(intent?.shouldIncludeReferences ? ensureReferencesSection(retryResult.content, sourceIndex, "References") : retryResult.content, maxWords),
              summary: "Draft generated through direct retry.",
              nextSteps: [
                "Verify factual claims against cited sources",
                "Adjust style and tone if needed",
                "Publish or share"
              ]
            };
            await emitWriterStageEvent({
              context,
              stage: "direct_retry",
              status: "completed",
              payload: {
                provider: retryResult.providerUsed ?? retryResult.provider,
                wordCount: countWords(draft.content),
                providerAttempts: retryResult.providerAttempts,
                timeoutMs: retryBudget.timeoutMs,
                promptChars: retryPromptChars,
                outputShape,
                ...llmTimingPayload(retryResult)
              }
            });
            if (intent) {
              const reviewBudget = computePassBudget({
                deadlineAtMs: context.deadlineAtMs,
                reserveMs: WRITER_RESERVED_TIME_MS,
                maxTimeoutMs: REVIEW_PASS_MAX_TIMEOUT_MS,
                minTimeoutMs: 6_500,
                maxAttempts: REVIEW_PASS_MAX_ATTEMPTS
              });
              if (reviewBudget.enabled) {
                const reviewPrompt = buildWriterReviewPrompt({
                  instruction: input.instruction,
                  intent,
                  draft,
                  maxWords,
                  sourceIndex
                });
                const reviewMessages = [
                  {
                    role: "system" as const,
                    content: "You are a writing evaluator. Judge whether the draft is the requested deliverable or just process commentary. Return strict JSON only."
                  },
                  {
                    role: "user" as const,
                    content: reviewPrompt
                  }
                ];
                const reviewResult = await runStructuredWithFallback({
                  providers,
                  request: {
                    schemaName: "writer_review_v1",
                    jsonSchema: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        deliverableStatus: { type: "string", enum: ["complete", "partial", "insufficient"] },
                        matchesRequestedShape: { type: "boolean" },
                        processCommentaryDetected: { type: "boolean" },
                        shouldPersist: { type: "boolean" },
                        missingRequirements: {
                          type: "array",
                          maxItems: 8,
                          items: { type: "string", minLength: 1, maxLength: 180 }
                        },
                        repairFocus: {
                          type: "array",
                          maxItems: 6,
                          items: { type: "string", minLength: 1, maxLength: 180 }
                        },
                        summary: { type: "string", minLength: 1, maxLength: 400 }
                      },
                      required: [
                        "deliverableStatus",
                        "matchesRequestedShape",
                        "processCommentaryDetected",
                        "shouldPersist",
                        "missingRequirements",
                        "repairFocus",
                        "summary"
                      ]
                    },
                    timeoutMs: reviewBudget.timeoutMs,
                    maxAttempts: reviewBudget.maxAttempts,
                    messages: reviewMessages
                  },
                  validator: WriterReviewSchema
                });
                await maybeRecordUsage(context, reviewResult.usage);
                passCount += 1;
                if (reviewResult.result) {
                  review = reviewResult.result;
                  providerUsed = providerUsed ?? reviewResult.providerUsed ?? reviewResult.provider;
                }
              }
            }
          } else {
            fallbackReason = retryResult.failureCode ?? fallbackReason;
            failureMessage = retryResult.failureMessage ?? failureMessage;
            await emitWriterStageEvent({
              context,
              stage: "direct_retry",
              status: "failed",
              payload: {
                failureCode: retryResult.failureCode ?? "empty_or_short_response",
                failureClass: retryResult.failureClass ?? "unknown",
                failureMessage: retryResult.failureMessage ?? null,
                providerAttempts: retryResult.providerAttempts,
                timeoutMs: retryBudget.timeoutMs,
                promptChars: retryPromptChars,
                outputShape,
                ...llmTimingPayload(retryResult)
              }
            });
          }
        } else {
          await emitWriterStageEvent({
            context,
            stage: "direct_retry",
            status: "skipped",
            payload: {
              reason: retryBudget.skipReason ?? "insufficient_deadline_budget",
              remainingMs: retryBudget.remainingMs,
              outputShape
            }
          });
        }
      }

      if (intent) {
        outputShape = intent.outputShape;
      }
      const mechanical = evaluateMechanicalQuality({
        content: intent?.shouldIncludeReferences ? ensureReferencesSection(draft.content, sourceIndex, "References") : draft.content,
        maxWords,
        outputShape,
        targetItemCount: intent?.targetItemCount,
        shouldIncludeReferences: intent?.shouldIncludeReferences ?? sourceIndex.length > 0,
        sourceIndex
      });
      draft.content = clipWords(
        (intent?.shouldIncludeReferences ?? false) ? ensureReferencesSection(draft.content, sourceIndex, "References") : draft.content,
        maxWords
      );

      if (review) {
        deliverableStatus = review.deliverableStatus;
        processCommentaryDetected = review.processCommentaryDetected;
      }
      if (review?.deliverableStatus === "complete" && mechanical.missing.length === 0) {
        draftQuality = "complete";
        fallbackUsed = false;
        fallbackReason = "none";
        failureMessage = null;
        deliverableStatus = "complete";
      } else {
        draftQuality = "placeholder";
        fallbackUsed = true;
        if (fallbackReason === "writer_not_completed") {
          fallbackReason = review ? `review_${review.deliverableStatus}` : "draft_quality_incomplete";
        }
        const missingSummary = review?.missingRequirements?.length ? review.missingRequirements.join(" ") : mechanical.missing.join(" ");
        failureMessage = failureMessage ?? (missingSummary || "Draft did not satisfy the requested deliverable.");
        if (!review && countWords(draft.content) >= 120) {
          deliverableStatus = "partial";
        }
      }

      await emitWriterStageEvent({
        context,
        stage: "structured_attempt",
        status: draftQuality === "complete" ? "completed" : "failed",
        payload: {
          provider: providerUsed,
          passCount,
          draftQuality,
          deliverableStatus,
          outputShape,
          processCommentaryDetected,
          fallbackUsed,
          fallbackReason,
          failureMessage
        }
      });
    } else {
      fallbackReason = "missing_api_key";
      failureMessage = "No writer LLM provider is configured for this run.";
      await emitWriterStageEvent({
        context,
        stage: "structured_attempt",
        status: "skipped",
        payload: {
          reason: "missing_api_key"
        }
      });
    }

    let writtenPath: string | null = null;
    let didWriteDraft = false;
    let preservedExistingDraft = false;
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
      ? (input.outputPath ?? buildDefaultSessionOutputPath({
          sessionId: context.sessionId,
          runId: context.runId,
          format
        }))
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

        const shouldPreventQualityDowngrade =
          draftQuality !== "complete" && shouldOverwrite && typeof existingContent === "string" && existingContent.trim().length > 0;

        if (shouldPreventQualityDowngrade) {
          const existingContentText = existingContent as string;
          const existingQuality = evaluateMechanicalQuality({
            content: existingContentText,
            maxWords,
            outputShape,
            targetItemCount: intent?.targetItemCount,
            shouldIncludeReferences: intent?.shouldIncludeReferences ?? sourceIndex.length > 0,
            sourceIndex
          });
          if (existingQuality.missing.length === 0) {
            preservedExistingDraft = true;
            writtenPath = relativeOutputPath;
            await emitWriterStageEvent({
              context,
              stage: "persist",
              status: "skipped",
              payload: {
                outputPath: writtenPath,
                reason: "quality_downgrade_prevented",
                attemptedDraftQuality: draftQuality,
                attemptedDeliverableStatus: deliverableStatus,
                attemptedWordCount: finalWordCount,
                existingDraftQuality: "complete",
                existingWordCount: existingQuality.wordCount,
                existingCitationCount: existingQuality.citationCount
              }
            });

            draft = {
              title: deriveTitleFromContent(existingContentText),
              content: existingContentText.trim(),
              summary: "Preserved existing complete draft at output path.",
              nextSteps: [
                "Review factual claims against cited sources",
                "Adjust style and voice for final publication",
                "Publish or share"
              ]
            };
            draftQuality = "complete";
            fallbackUsed = false;
            fallbackReason = "none";
            failureMessage = null;
            deliverableStatus = "complete";
            processCommentaryDetected = false;
            context.addArtifact(writtenPath);
          }
        }

        if (!preservedExistingDraft) {
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
              deliverableStatus,
              draftQuality
            }
          });
        }
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
      const absoluteOutput = resolvePathInProject(context.projectRoot, resolvedOutputPath);
      let existingContent: string | null = null;
      try {
        existingContent = await readFile(absoluteOutput, "utf8");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (input.overwrite === false && existingContent !== null) {
        throw new Error("output file already exists and overwrite=false");
      }
      if (draftQuality !== "complete" && typeof existingContent === "string" && existingContent.trim().length > 0) {
        const existingQuality = evaluateMechanicalQuality({
          content: existingContent,
          maxWords,
          outputShape,
          targetItemCount: intent?.targetItemCount,
          shouldIncludeReferences: intent?.shouldIncludeReferences ?? sourceIndex.length > 0,
          sourceIndex
        });
        if (existingQuality.missing.length === 0) {
          preservedExistingDraft = true;
          writtenPath = toProjectRelative(context.projectRoot, absoluteOutput);
          draft = {
            title: deriveTitleFromContent(existingContent),
            content: existingContent.trim(),
            summary: "Preserved existing complete draft at output path.",
            nextSteps: [
              "Review factual claims against cited sources",
              "Adjust style and voice for final publication",
              "Publish or share"
            ]
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
              reason: "quality_downgrade_prevented",
              attemptedDraftQuality: "placeholder",
              attemptedDeliverableStatus: deliverableStatus,
              attemptedWordCount: finalWordCount,
              existingDraftQuality: "complete",
              existingWordCount: existingQuality.wordCount,
              existingCitationCount: existingQuality.citationCount
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
