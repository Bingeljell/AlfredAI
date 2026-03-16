import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmUsage } from "../../../types.js";
import type { LeadAgentToolDefinition } from "../../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";
import type { ResearchSourceCard } from "../../types.js";
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

const WriterPlanSchema = z.object({
  headline: z.string().min(3).max(180),
  referencesHeading: z.string().min(3).max(40).default("References"),
  sections: z.array(z.object({
    heading: z.string().min(2).max(120),
    objective: z.string().min(10).max(260),
    targetWords: z.number().int().min(60).max(260)
  })).min(3).max(7)
});

const WriterSectionSchema = z.object({
  content: z.string().min(60).max(2800),
  sourceIdsUsed: z.array(z.number().int().min(1).max(30)).max(12)
});

const WriterQualityReviewSchema = z.object({
  revisedContent: z.string().min(120).max(12000),
  summary: z.string().min(1).max(800),
  nextSteps: z.array(z.string().min(1).max(200)).max(6),
  isComplete: z.boolean(),
  missingRequirements: z.array(z.string().min(1).max(160)).max(8)
});

const MAX_SOURCE_CARDS_FOR_PROMPT = 14;
const MAX_SECTION_COUNT = 6;
const WRITER_RESERVED_TIME_MS = 10_000;
const PLAN_PASS_MAX_TIMEOUT_MS = 35_000;
const SECTION_PASS_MAX_TIMEOUT_MS = 45_000;
const POLISH_PASS_MAX_TIMEOUT_MS = 60_000;
const REPAIR_PASS_MAX_TIMEOUT_MS = 45_000;
const COMPACT_RETRY_MAX_TIMEOUT_MS = 35_000;
const PLAN_PASS_MAX_ATTEMPTS = 2;
const SECTION_PASS_MAX_ATTEMPTS = 2;
const POLISH_PASS_MAX_ATTEMPTS = 2;
const REPAIR_PASS_MAX_ATTEMPTS = 2;
const COMPACT_RETRY_MAX_ATTEMPTS = 2;

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
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length;
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
  format: ReturnType<typeof normalizeWriterFormat>;
}): string {
  const suffix = args.format === "blog_post" ? "article" : args.format;
  return path.posix.join("workspace", "alfred", "sessions", args.sessionId, "outputs", `${args.runId}-${suffix}.md`);
}

function normalizeWriterFormat(value: unknown): "blog_post" | "email" | "memo" | "outline" | "social_post" | "notes" {
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

function pickSectionCount(maxWords: number): number {
  if (maxWords >= 1000) {
    return 6;
  }
  if (maxWords >= 760) {
    return 5;
  }
  if (maxWords >= 520) {
    return 4;
  }
  return 3;
}

function normalizeSectionTargets(sections: Array<{ heading: string; objective: string; targetWords: number }>, maxWords: number) {
  const capped = sections.slice(0, MAX_SECTION_COUNT);
  if (capped.length === 0) {
    return [];
  }
  const total = capped.reduce((sum, section) => sum + section.targetWords, 0);
  if (total <= 0) {
    const defaultTarget = clampInt(Math.round(maxWords / capped.length), 70, 240);
    return capped.map((section) => ({ ...section, targetWords: defaultTarget }));
  }
  const scale = maxWords / total;
  return capped.map((section) => ({
    ...section,
    targetWords: clampInt(Math.round(section.targetWords * scale), 70, 240)
  }));
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
  const markerRegex = /\breferences\b/i;
  if (markerRegex.test(normalized)) {
    return normalized;
  }
  const sourceIds = extractSourceIdsFromContent(normalized, sourceIndex.length);
  const references = buildReferencesBlock(sourceIndex, sourceIds, heading);
  return `${normalized}${references}`.trim();
}

function evaluateDraftCompleteness(content: string, maxWords: number): {
  wordCount: number;
  citationCount: number;
  isComplete: boolean;
  missing: string[];
} {
  const wordCount = countWords(content);
  const citationCount = (content.match(/\[S\d+\]/g) ?? []).length;
  const minWords = Math.max(320, Math.round(maxWords * 0.7));
  const missing: string[] = [];
  if (wordCount < minWords) {
    missing.push(`Word count below target (${wordCount}/${minWords}+).`);
  }
  if (citationCount < 4) {
    missing.push(`Too few citation markers (${citationCount}/4+).`);
  }
  if (!/\breferences\b/i.test(content)) {
    missing.push("References section missing.");
  }
  return {
    wordCount,
    citationCount,
    isComplete: missing.length === 0,
    missing
  };
}

function shouldPersistPlaceholderDraft(args: {
  providersConfigured: boolean;
  draftQuality: "complete" | "placeholder";
  fallbackWordCount: number;
  sourceCardCount: number;
  contextSnippetCount: number;
  fallbackReason: string;
  failureMessage: string | null;
}): boolean {
  if (args.draftQuality === "complete") {
    return true;
  }
  const blockedReasons = new Set([
    "multi_pass_no_output",
    "compact_retry_skipped",
    "plan_pass_skipped",
    "writer_not_completed"
  ]);
  const normalizedFailure = (args.failureMessage ?? "").toLowerCase();
  if (
    blockedReasons.has(args.fallbackReason)
    || normalizedFailure.includes("insufficient_deadline_budget")
    || normalizedFailure.includes("low remaining budget")
  ) {
    return false;
  }
  if (!args.providersConfigured) {
    return args.fallbackWordCount >= 140 || ((args.sourceCardCount > 0 || args.contextSnippetCount > 0) && args.fallbackWordCount >= 90);
  }
  return args.fallbackWordCount >= 140 || ((args.sourceCardCount > 0 || args.contextSnippetCount > 0) && args.fallbackWordCount >= 90);
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

function buildSectionPrompt(args: {
  instruction: string;
  tone: string;
  audience: string;
  section: { heading: string; objective: string; targetWords: number };
  sourceIndex: SourceIndexEntry[];
  contextSnippets: string[];
}): string {
  const sourceLines = args.sourceIndex
    .map((source) => `- [S${source.id}] ${source.title} | ${source.url} | key point: ${source.claim}`)
    .join("\n");
  const contextLines = args.contextSnippets.length > 0
    ? args.contextSnippets.slice(0, 3).map((snippet) => `- ${clipText(snippet, 220)}`).join("\n")
    : "- none";

  return [
    `Article objective: ${args.instruction}`,
    `Tone: ${args.tone}`,
    `Audience: ${args.audience}`,
    `Section heading: ${args.section.heading}`,
    `Section objective: ${args.section.objective}`,
    `Target words for this section: ${args.section.targetWords}`,
    "Use only the sources listed below. Cite factual statements with markers like [S3].",
    "Do not invent sources or facts. If evidence is thin, say so briefly.",
    `Sources:\n${sourceLines}`,
    `Extra context:\n${contextLines}`
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
    let fallbackUsed = true;
    let fallbackReason = "writer_not_completed";
    let failureMessage: string | null = null;
    let draftQuality: "complete" | "placeholder" = "placeholder";
    let compactRetryUsed = false;
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
      draftQuality = "placeholder";
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

      const planningBudget = computePassBudget({
        deadlineAtMs: context.deadlineAtMs,
        reserveMs: WRITER_RESERVED_TIME_MS,
        maxTimeoutMs: PLAN_PASS_MAX_TIMEOUT_MS,
        minTimeoutMs: 8_000,
        maxAttempts: PLAN_PASS_MAX_ATTEMPTS
      });

      let plan: z.infer<typeof WriterPlanSchema> | null = null;
      if (planningBudget.enabled) {
        const sectionTarget = pickSectionCount(maxWords);
        const planPrompt = [
          `Instruction: ${input.instruction}`,
          `Format: ${format}`,
          `Tone: ${tone}`,
          `Audience: ${audience}`,
          `Target words: ${maxWords}`,
          `Desired section count: ${sectionTarget}`,
          "Design a section plan that works for any topic. Keep headings specific and objectives factual.",
          "Prefer sections that can be grounded in provided sources and support citations.",
          sourceIndex.length > 0
            ? `Available sources:\n${sourceIndex.map((item) => `- [S${item.id}] ${item.title} | ${item.url} | key point: ${item.claim}`).join("\n")}`
            : "Available sources: none",
          contextSnippets.length > 0
            ? `Context snippets:\n${contextSnippets.slice(0, 3).map((item) => `- ${clipText(item, 220)}`).join("\n")}`
            : "Context snippets: none"
        ].join("\n\n");
        const planMessages = [
          {
            role: "system" as const,
            content: "You are an editorial planner. Produce only valid JSON matching the schema."
          },
          {
            role: "user" as const,
            content: planPrompt
          }
        ];
        const planPromptChars = countMessageChars(planMessages);
        await emitWriterStageEvent({
          context,
          stage: "plan_pass",
          status: "started",
          payload: {
            timeoutMs: planningBudget.timeoutMs,
            maxAttempts: planningBudget.maxAttempts,
            remainingMs: planningBudget.remainingMs,
            promptChars: planPromptChars
          }
        });

        const planResult = await runStructuredWithFallback({
          providers,
          request: {
            schemaName: "writer_plan_v1",
            jsonSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                headline: { type: "string", minLength: 3, maxLength: 180 },
                referencesHeading: { type: "string", minLength: 3, maxLength: 40 },
                sections: {
                  type: "array",
                  minItems: 3,
                  maxItems: 7,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      heading: { type: "string", minLength: 2, maxLength: 120 },
                      objective: { type: "string", minLength: 10, maxLength: 260 },
                      targetWords: { type: "integer", minimum: 60, maximum: 260 }
                    },
                    required: ["heading", "objective", "targetWords"]
                  }
                }
              },
              required: ["headline", "referencesHeading", "sections"]
            },
            timeoutMs: planningBudget.timeoutMs,
            maxAttempts: planningBudget.maxAttempts,
            messages: planMessages
          },
          validator: WriterPlanSchema
        });
        await maybeRecordUsage(context, planResult.usage);
        passCount += 1;
        if (planResult.result) {
          providerUsed = planResult.providerUsed ?? planResult.provider;
          plan = planResult.result;
          await emitWriterStageEvent({
            context,
            stage: "plan_pass",
            status: "completed",
            payload: {
              provider: providerUsed,
              sectionCount: plan.sections.length,
              providerAttempts: planResult.providerAttempts,
              timeoutMs: planningBudget.timeoutMs,
              promptChars: planPromptChars,
              ...llmTimingPayload(planResult)
            }
          });
        } else {
          fallbackReason = planResult.failureCode ?? "plan_pass_failed";
          failureMessage = planResult.failureMessage ?? "Plan pass failed";
          await emitWriterStageEvent({
            context,
            stage: "plan_pass",
            status: "failed",
            payload: {
              failureCode: planResult.failureCode ?? "unknown",
              failureClass: planResult.failureClass ?? "unknown",
              failureMessage: planResult.failureMessage ?? null,
              providerAttempts: planResult.providerAttempts,
              timeoutMs: planningBudget.timeoutMs,
              promptChars: planPromptChars,
              ...llmTimingPayload(planResult)
            }
          });
        }
      } else {
        fallbackReason = "plan_pass_skipped";
        failureMessage = `Planning skipped due to low remaining budget (${planningBudget.remainingMs}ms)`;
        await emitWriterStageEvent({
          context,
          stage: "plan_pass",
          status: "skipped",
          payload: {
            reason: planningBudget.skipReason ?? "insufficient_deadline_budget",
            remainingMs: planningBudget.remainingMs
          }
        });
      }

      let assembledSections = "";
      let referencesHeading = "References";
      let usedSourceIds = new Set<number>();
      if (plan) {
        referencesHeading = plan.referencesHeading || "References";
        const normalizedSections = normalizeSectionTargets(plan.sections, maxWords).slice(0, MAX_SECTION_COUNT);
        const sectionResults: string[] = [];
        for (let index = 0; index < normalizedSections.length; index += 1) {
          const section = normalizedSections[index];
          const sectionBudget = computePassBudget({
            deadlineAtMs: context.deadlineAtMs,
            reserveMs: WRITER_RESERVED_TIME_MS,
            maxTimeoutMs: SECTION_PASS_MAX_TIMEOUT_MS,
            minTimeoutMs: 7_000,
            maxAttempts: SECTION_PASS_MAX_ATTEMPTS
          });
          if (!sectionBudget.enabled) {
            await emitWriterStageEvent({
              context,
              stage: "section_pass",
              status: "skipped",
              payload: {
                sectionIndex: index + 1,
                heading: section.heading,
                reason: sectionBudget.skipReason ?? "insufficient_deadline_budget",
                remainingMs: sectionBudget.remainingMs
              }
            });
            break;
          }

          const sectionPrompt = buildSectionPrompt({
            instruction: input.instruction,
            tone,
            audience,
            section,
            sourceIndex,
            contextSnippets
          });
          const sectionMessages = [
            {
              role: "system" as const,
              content:
                "You are a factual section writer. Use only provided evidence. Add citation markers like [S3] for factual claims. Return strict JSON."
            },
            {
              role: "user" as const,
              content: sectionPrompt
            }
          ];
          const sectionPromptChars = countMessageChars(sectionMessages);

          await emitWriterStageEvent({
            context,
            stage: "section_pass",
            status: "started",
            payload: {
              sectionIndex: index + 1,
              heading: section.heading,
              timeoutMs: sectionBudget.timeoutMs,
              maxAttempts: sectionBudget.maxAttempts,
              remainingMs: sectionBudget.remainingMs,
              promptChars: sectionPromptChars
            }
          });

          const sectionResult = await runStructuredWithFallback({
            providers,
            request: {
              schemaName: "writer_section_v1",
              jsonSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  content: { type: "string", minLength: 60, maxLength: 2800 },
                  sourceIdsUsed: {
                    type: "array",
                    maxItems: 12,
                    items: { type: "integer", minimum: 1, maximum: MAX_SOURCE_CARDS_FOR_PROMPT }
                  }
                },
                required: ["content", "sourceIdsUsed"]
              },
              timeoutMs: sectionBudget.timeoutMs,
              maxAttempts: sectionBudget.maxAttempts,
              messages: sectionMessages
            },
            validator: WriterSectionSchema
          });
          await maybeRecordUsage(context, sectionResult.usage);
          passCount += 1;

          if (!sectionResult.result) {
            await emitWriterStageEvent({
              context,
              stage: "section_pass",
              status: "failed",
              payload: {
                sectionIndex: index + 1,
                heading: section.heading,
                failureCode: sectionResult.failureCode ?? "unknown",
                failureClass: sectionResult.failureClass ?? "unknown",
                failureMessage: sectionResult.failureMessage ?? null,
                providerAttempts: sectionResult.providerAttempts,
                timeoutMs: sectionBudget.timeoutMs,
                promptChars: sectionPromptChars,
                ...llmTimingPayload(sectionResult)
              }
            });
            fallbackReason = sectionResult.failureCode ?? "section_pass_failed";
            failureMessage = sectionResult.failureMessage ?? `Section ${index + 1} failed`;
            break;
          }

          providerUsed = providerUsed ?? sectionResult.providerUsed ?? sectionResult.provider;
          const sectionContent = clipWords(sectionResult.result.content, section.targetWords + 30);
          if (countWords(sectionContent) < Math.max(55, Math.round(section.targetWords * 0.5))) {
            await emitWriterStageEvent({
              context,
              stage: "section_pass",
              status: "failed",
              payload: {
                sectionIndex: index + 1,
                heading: section.heading,
                failureCode: "section_too_short",
                failureClass: "schema",
                failureMessage: "Section output was too short",
                timeoutMs: sectionBudget.timeoutMs,
                promptChars: sectionPromptChars,
                ...llmTimingPayload(sectionResult)
              }
            });
            fallbackReason = "section_too_short";
            failureMessage = `Section ${index + 1} output was too short`;
            break;
          }

          for (const id of sectionResult.result.sourceIdsUsed) {
            if (id >= 1 && id <= sourceIndex.length) {
              usedSourceIds.add(id);
            }
          }
          for (const id of extractSourceIdsFromContent(sectionContent, sourceIndex.length)) {
            usedSourceIds.add(id);
          }

          sectionResults.push(`## ${section.heading}\n${sectionContent.trim()}`);
          await emitWriterStageEvent({
            context,
            stage: "section_pass",
            status: "completed",
            payload: {
              sectionIndex: index + 1,
              heading: section.heading,
              wordCount: countWords(sectionContent),
              provider: sectionResult.providerUsed ?? sectionResult.provider,
              sourceIdsUsed: Array.from(usedSourceIds).slice(0, 12),
              timeoutMs: sectionBudget.timeoutMs,
              promptChars: sectionPromptChars,
              ...llmTimingPayload(sectionResult)
            }
          });
        }

        assembledSections = sectionResults.join("\n\n").trim();
      }

      if (assembledSections) {
        const references = buildReferencesBlock(sourceIndex, Array.from(usedSourceIds), referencesHeading);
        let assembledDraft = [
          `# ${plan?.headline ?? deriveTitle(input.instruction)}`,
          assembledSections,
          references
        ].filter(Boolean).join("\n\n");

        assembledDraft = clipWords(assembledDraft, maxWords);

        const polishBudget = computePassBudget({
          deadlineAtMs: context.deadlineAtMs,
          reserveMs: WRITER_RESERVED_TIME_MS,
          maxTimeoutMs: POLISH_PASS_MAX_TIMEOUT_MS,
          minTimeoutMs: 8_000,
          maxAttempts: POLISH_PASS_MAX_ATTEMPTS
        });

        if (polishBudget.enabled) {
          const polishPrompt = [
            `Instruction: ${input.instruction}`,
            `Format: ${format}`,
            `Tone: ${tone}`,
            `Audience: ${audience}`,
            `Max words: ${maxWords}`,
            "Keep [S#] markers and include a references section mapping markers to URLs.",
            sourceIndex.length > 0
              ? `Source index:\n${sourceIndex.map((item) => `- [S${item.id}] ${item.title} — ${item.url}`).join("\n")}`
              : "Source index: none",
            `Draft to polish:\n${assembledDraft}`
          ].join("\n\n");
          const polishMessages = [
            {
              role: "system" as const,
              content:
                "You are a senior editor. Improve coherence and flow while preserving factual grounding and [S#] citation markers. Return strict JSON."
            },
            {
              role: "user" as const,
              content: polishPrompt
            }
          ];
          const polishPromptChars = countMessageChars(polishMessages);

          await emitWriterStageEvent({
            context,
            stage: "polish_pass",
            status: "started",
            payload: {
              timeoutMs: polishBudget.timeoutMs,
              maxAttempts: polishBudget.maxAttempts,
              remainingMs: polishBudget.remainingMs,
              promptChars: polishPromptChars
            }
          });
          const polishResult = await runStructuredWithFallback({
            providers,
            request: {
              schemaName: "writer_polish_v1",
              jsonSchema: WRITER_RESPONSE_JSON_SCHEMA,
              timeoutMs: polishBudget.timeoutMs,
              maxAttempts: polishBudget.maxAttempts,
              messages: polishMessages
            },
            validator: WriterResponseSchema
          });
          await maybeRecordUsage(context, polishResult.usage);
          passCount += 1;

          if (polishResult.result) {
            providerUsed = providerUsed ?? polishResult.providerUsed ?? polishResult.provider;
            draft = {
              ...polishResult.result,
              content: clipWords(
                ensureReferencesSection(polishResult.result.content, sourceIndex, referencesHeading),
                maxWords
              )
            };
            await emitWriterStageEvent({
              context,
              stage: "polish_pass",
              status: "completed",
              payload: {
                provider: polishResult.providerUsed ?? polishResult.provider,
                wordCount: countWords(draft.content),
                providerAttempts: polishResult.providerAttempts,
                timeoutMs: polishBudget.timeoutMs,
                promptChars: polishPromptChars,
                ...llmTimingPayload(polishResult)
              }
            });
          } else {
            await emitWriterStageEvent({
              context,
              stage: "polish_pass",
              status: "failed",
              payload: {
                failureCode: polishResult.failureCode ?? "unknown",
                failureClass: polishResult.failureClass ?? "unknown",
                failureMessage: polishResult.failureMessage ?? null,
                providerAttempts: polishResult.providerAttempts,
                timeoutMs: polishBudget.timeoutMs,
                promptChars: polishPromptChars,
                ...llmTimingPayload(polishResult)
              }
            });
            draft = {
              title: plan?.headline ?? deriveTitle(input.instruction),
              content: ensureReferencesSection(assembledDraft, sourceIndex, referencesHeading),
              summary: "Draft assembled from multi-pass section synthesis.",
              nextSteps: [
                "Verify factual claims against cited sources",
                "Adjust style and voice for final publication",
                "Publish or share"
              ]
            };
            fallbackUsed = true;
            fallbackReason = polishResult.failureCode ?? "polish_pass_failed";
            failureMessage = polishResult.failureMessage ?? failureMessage;
          }
        } else {
          await emitWriterStageEvent({
            context,
            stage: "polish_pass",
            status: "skipped",
            payload: {
              reason: polishBudget.skipReason ?? "insufficient_deadline_budget",
              remainingMs: polishBudget.remainingMs
            }
          });
          draft = {
            title: plan?.headline ?? deriveTitle(input.instruction),
            content: ensureReferencesSection(assembledDraft, sourceIndex, referencesHeading),
            summary: "Draft assembled from multi-pass section synthesis.",
            nextSteps: [
              "Verify factual claims against cited sources",
              "Adjust style and voice for final publication",
              "Publish or share"
            ]
          };
          fallbackUsed = true;
          fallbackReason = "polish_pass_skipped";
          failureMessage = `Polish pass skipped due to low remaining budget (${polishBudget.remainingMs}ms)`;
        }

        const quality = evaluateDraftCompleteness(draft.content, maxWords);
        if (!quality.isComplete) {
          const repairBudget = computePassBudget({
            deadlineAtMs: context.deadlineAtMs,
            reserveMs: WRITER_RESERVED_TIME_MS,
            maxTimeoutMs: REPAIR_PASS_MAX_TIMEOUT_MS,
            minTimeoutMs: 7_000,
            maxAttempts: REPAIR_PASS_MAX_ATTEMPTS
          });
          if (repairBudget.enabled) {
            compactRetryUsed = true;
            const repairPrompt = [
              `Instruction: ${input.instruction}`,
              `Target max words: ${maxWords}`,
              `Missing requirements:\n${quality.missing.map((item) => `- ${item}`).join("\n")}`,
              sourceIndex.length > 0
                ? `Source index:\n${sourceIndex.map((item) => `- [S${item.id}] ${item.title} — ${item.url}`).join("\n")}`
                : "Source index: none",
              `Current draft:\n${draft.content}`
            ].join("\n\n");
            const repairMessages = [
              {
                role: "system" as const,
                content:
                  "You are a writing QA editor. Fix only missing requirements while preserving factual grounding and [S#] citations. Return strict JSON."
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
                missing: quality.missing,
                remainingMs: repairBudget.remainingMs,
                promptChars: repairPromptChars
              }
            });
            const repairResult = await runStructuredWithFallback({
              providers,
              request: {
                schemaName: "writer_repair_v1",
                jsonSchema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    revisedContent: { type: "string", minLength: 120, maxLength: 12000 },
                    summary: { type: "string", minLength: 1, maxLength: 800 },
                    nextSteps: {
                      type: "array",
                      maxItems: 6,
                      items: { type: "string", minLength: 1, maxLength: 200 }
                    },
                    isComplete: { type: "boolean" },
                    missingRequirements: {
                      type: "array",
                      maxItems: 8,
                      items: { type: "string", minLength: 1, maxLength: 160 }
                    }
                  },
                  required: ["revisedContent", "summary", "nextSteps", "isComplete", "missingRequirements"]
                },
                timeoutMs: repairBudget.timeoutMs,
                maxAttempts: repairBudget.maxAttempts,
                messages: repairMessages
              },
              validator: WriterQualityReviewSchema
            });
            await maybeRecordUsage(context, repairResult.usage);
            passCount += 1;
            if (repairResult.result) {
              providerUsed = providerUsed ?? repairResult.providerUsed ?? repairResult.provider;
              draft = {
                ...draft,
                content: clipWords(
                  ensureReferencesSection(repairResult.result.revisedContent, sourceIndex, referencesHeading),
                  maxWords
                ),
                summary: repairResult.result.summary,
                nextSteps: repairResult.result.nextSteps
              };
              await emitWriterStageEvent({
                context,
                stage: "repair_pass",
                status: "completed",
                payload: {
                  provider: repairResult.providerUsed ?? repairResult.provider,
                  isComplete: repairResult.result.isComplete,
                  missing: repairResult.result.missingRequirements,
                  timeoutMs: repairBudget.timeoutMs,
                  promptChars: repairPromptChars,
                  ...llmTimingPayload(repairResult)
                }
              });
            } else {
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
                  ...llmTimingPayload(repairResult)
                }
              });
            }
          }
        }

        const finalQuality = evaluateDraftCompleteness(draft.content, maxWords);
        if (finalQuality.isComplete) {
          fallbackUsed = false;
          fallbackReason = "none";
          failureMessage = null;
          draftQuality = "complete";
        } else {
          fallbackUsed = true;
          fallbackReason = fallbackReason === "none" ? "quality_checks_incomplete" : fallbackReason;
          failureMessage = failureMessage ?? finalQuality.missing.join(" ");
          draftQuality = "placeholder";
        }
      }

      if (!assembledSections) {
        const compactBudget = computePassBudget({
          deadlineAtMs: context.deadlineAtMs,
          reserveMs: WRITER_RESERVED_TIME_MS,
          maxTimeoutMs: COMPACT_RETRY_MAX_TIMEOUT_MS,
          minTimeoutMs: 6_500,
          maxAttempts: COMPACT_RETRY_MAX_ATTEMPTS
        });
        if (compactBudget.enabled) {
          const compactPrompt = [
            `Write a complete ${format} draft now.`,
            `Instruction: ${input.instruction}`,
            `Tone: ${tone}`,
            `Audience: ${audience}`,
            `Word limit: ${maxWords}`,
            "Use source markers like [S1] for factual claims.",
            sourceIndex.length > 0
              ? `Sources:\n${sourceIndex.map((item) => `- [S${item.id}] ${item.title} | ${item.url} | ${item.claim}`).join("\n")}`
              : "Sources: none"
          ].join("\n\n");
          const compactMessages = [
            {
              role: "system" as const,
              content: "You are a concise writing assistant. Produce only the requested article text."
            },
            {
              role: "user" as const,
              content: compactPrompt
            }
          ];
          const compactPromptChars = countMessageChars(compactMessages);
          await emitWriterStageEvent({
            context,
            stage: "compact_retry",
            status: "started",
            payload: {
              reason: "multi_pass_unavailable",
              priorFallbackReason: fallbackReason,
              maxWords,
              format,
              timeoutMs: compactBudget.timeoutMs,
              maxAttempts: compactBudget.maxAttempts,
              remainingMs: compactBudget.remainingMs,
              promptChars: compactPromptChars
            }
          });

          const compactResult = await runTextWithFallback({
            providers,
            request: {
              timeoutMs: compactBudget.timeoutMs,
              maxAttempts: compactBudget.maxAttempts,
              messages: compactMessages
            }
          });
          await maybeRecordUsage(context, compactResult.usage);
          passCount += 1;
          compactRetryUsed = true;

          if (compactResult.content && countWords(compactResult.content) >= 120) {
            providerUsed = providerUsed ?? compactResult.providerUsed ?? compactResult.provider;
            const contentWithRefs = ensureReferencesSection(clipWords(compactResult.content, maxWords), sourceIndex, "References");
            draft = {
              title: `Draft: ${deriveTitle(input.instruction)}`,
              content: contentWithRefs,
              summary: "Draft generated through compact retry.",
              nextSteps: [
                "Verify factual claims against cited sources",
                "Adjust voice and tone",
                "Publish or share"
              ]
            };
            const quality = evaluateDraftCompleteness(draft.content, maxWords);
            draftQuality = quality.isComplete ? "complete" : "placeholder";
            fallbackUsed = !quality.isComplete;
            fallbackReason = quality.isComplete ? "none" : "compact_retry_incomplete";
            failureMessage = quality.isComplete ? null : quality.missing.join(" ");
            await emitWriterStageEvent({
              context,
              stage: "compact_retry",
              status: "completed",
              payload: {
                provider: compactResult.providerUsed ?? compactResult.provider,
                wordCount: countWords(draft.content),
                providerAttempts: compactResult.providerAttempts,
                timeoutMs: compactBudget.timeoutMs,
                promptChars: compactPromptChars,
                ...llmTimingPayload(compactResult)
              }
            });
          } else {
            await emitWriterStageEvent({
              context,
              stage: "compact_retry",
              status: "failed",
              payload: {
                reason: compactResult.failureCode ?? "empty_or_short_response",
                failureMessage: compactResult.failureMessage ?? null,
                providerAttempts: compactResult.providerAttempts,
                timeoutMs: compactBudget.timeoutMs,
                promptChars: compactPromptChars,
                ...llmTimingPayload(compactResult)
              }
            });
            draft = buildFallbackDraft({
              reason: compactResult.failureMessage ?? failureMessage ?? fallbackReason,
              instruction: input.instruction,
              format,
              audience,
              tone,
              maxWords,
              contextSnippets,
              sourceCards
            });
            fallbackUsed = true;
            fallbackReason = compactResult.failureCode ?? fallbackReason;
            failureMessage = compactResult.failureMessage ?? failureMessage;
            draftQuality = "placeholder";
          }
        } else {
          await emitWriterStageEvent({
            context,
            stage: "compact_retry",
            status: "failed",
            payload: {
              reason: "insufficient_deadline_budget",
              priorFallbackReason: fallbackReason,
              maxWords,
              format,
              timeoutMs: compactBudget.timeoutMs,
              maxAttempts: compactBudget.maxAttempts,
              remainingMs: compactBudget.remainingMs
            }
          });
          fallbackUsed = true;
          if (fallbackReason === "none") {
            fallbackReason = "compact_retry_skipped";
          }
          failureMessage = failureMessage ?? `Compact retry skipped due to low remaining budget (${compactBudget.remainingMs}ms)`;
        }
      }

      if (!assembledSections && fallbackReason === "writer_not_completed") {
        fallbackReason = compactRetryUsed ? "compact_retry_incomplete" : "multi_pass_no_output";
        fallbackUsed = true;
      }

      if (!assembledSections && !failureMessage) {
        failureMessage = "Writer did not assemble any section output.";
      }

      await emitWriterStageEvent({
        context,
        stage: "structured_attempt",
        status: draftQuality === "complete" ? "completed" : "failed",
        payload: {
          provider: providerUsed,
          passCount,
          draftQuality,
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
      draftQuality = "placeholder";
    }

    let writtenPath: string | null = null;
    let didWriteDraft = false;
    let preservedExistingDraft = false;
    const fallbackWordCount = countWords(draft.content);
    const shouldPersistDraft = shouldPersistPlaceholderDraft({
      providersConfigured: providers.length > 0,
      draftQuality,
      fallbackWordCount,
      sourceCardCount: sourceCards.length,
      contextSnippetCount: contextSnippets.length,
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
          const existingQuality = evaluateDraftCompleteness(existingContentText, maxWords);
          if (existingQuality.isComplete) {
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
                attemptedWordCount: fallbackWordCount,
                existingDraftQuality: "complete",
                existingWordCount: existingQuality.wordCount,
                existingCitationCount: existingQuality.citationCount
              }
            });

            // Preserve the last complete file as the visible output for this call.
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
              wordCount: countWords(draft.content)
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
        const existingQuality = evaluateDraftCompleteness(existingContent, maxWords);
        if (existingQuality.isComplete) {
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
          context.addArtifact(writtenPath);
          await emitWriterStageEvent({
            context,
            stage: "persist",
            status: "skipped",
            payload: {
              outputPath: writtenPath,
              reason: "quality_downgrade_prevented",
              attemptedDraftQuality: "placeholder",
              attemptedWordCount: fallbackWordCount,
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
            compactRetryUsed,
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
          wordCount: fallbackWordCount,
          autoSelectedOutputPath: !input.outputPath,
          fallbackReason,
          failureMessage
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
      compactRetryUsed,
      providerUsed,
      passCount,
      persistedFallbackDraft: didWriteDraft && draftQuality !== "complete",
      outputPath: writtenPath
    };
  }
};
