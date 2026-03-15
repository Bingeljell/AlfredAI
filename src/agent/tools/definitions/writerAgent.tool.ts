import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmUsage } from "../../../types.js";
import { runOpenAiChat, runOpenAiStructuredChatWithDiagnostics } from "../../../services/openAiClient.js";
import type { LeadAgentToolDefinition } from "../../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";
import type { ResearchSourceCard } from "../../types.js";

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

function deriveTitle(instruction: string): string {
  const trimmed = instruction.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "Draft";
  }
  return clipText(trimmed, 80);
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

async function runCompactRetryDraft(args: {
  apiKey: string;
  instruction: string;
  format: string;
  audience: string;
  tone: string;
  maxWords: number;
  sourceCards: ResearchSourceCard[];
  contextSnippets: string[];
}): Promise<{ title: string; content: string; summary: string; nextSteps: string[] } | null> {
  const sourceLines = sourceCardBullets(args.sourceCards, 8);
  const contextLines = args.contextSnippets.slice(0, 4).map((item) => `- ${clipText(item, 180)}`);
  const userPrompt = [
    `Write a complete ${args.format} draft now.`,
    `Instruction: ${args.instruction}`,
    `Tone: ${args.tone}`,
    `Audience: ${args.audience}`,
    `Word limit: ${args.maxWords}`,
    "Use plain text only (no JSON).",
    "If evidence is weak, state uncertainty instead of inventing facts.",
    sourceLines.length > 0 ? `Sources:\n${sourceLines.map((line) => `- ${line}`).join("\n")}` : "Sources: none",
    contextLines.length > 0 ? `Context:\n${contextLines.join("\n")}` : "Context: none"
  ].join("\n\n");
  const retryResponse = await runOpenAiChat({
    apiKey: args.apiKey,
    messages: [
      {
        role: "system",
        content: "You are a concise writing assistant. Produce only the requested draft text with concrete structure."
      },
      {
        role: "user",
        content: userPrompt
      }
    ]
  });
  if (!retryResponse) {
    return null;
  }
  const content = clipWords(retryResponse, args.maxWords);
  if (countWords(content) < 120) {
    return null;
  }
  return {
    title: `Draft: ${deriveTitle(args.instruction)}`,
    content,
    summary: "Draft generated via compact retry path after primary structured call failed.",
    nextSteps: ["Verify factual claims against cited sources", "Adjust style for final publication", "Publish or share"]
  };
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

export const toolDefinition: LeadAgentToolDefinition<typeof WriterAgentToolInputSchema> = {
  name: "writer_agent",
  description: "Generate structured written drafts (blog/email/memo/etc.) from instructions and optional local context.",
  inputSchema: WriterAgentToolInputSchema,
  inputHint: "Use for drafting content quickly; set outputPath to save draft to a file.",
  async execute(input, context) {
    const format = input.format ?? "blog_post";
    const tone = input.tone ?? "clear and practical";
    const audience = input.audience ?? "general technical audience";
    const maxWords = input.maxWords ?? 700;
    const contextSnippets = await loadContextSnippets(context.projectRoot, input.contextPaths);
    const sourceCards = (context.getResearchSourceCards?.() ?? context.state.researchSourceCards ?? []).slice(-20);

    let draft = buildFallbackDraft({
      reason: "OpenAI API key is missing",
      instruction: input.instruction,
      format,
      audience,
      tone,
      maxWords,
      contextSnippets,
      sourceCards
    });
    let fallbackUsed = true;
    let fallbackReason = "missing_api_key";
    let failureMessage: string | null = null;
    let draftQuality: "complete" | "placeholder" = "placeholder";
    let compactRetryUsed = false;

    if (context.openAiApiKey) {
      await emitWriterStageEvent({
        context,
        stage: "structured_attempt",
        status: "started",
        payload: {
          maxWords,
          format,
          hasOutputPath: Boolean(input.outputPath),
          sourceCardCount: sourceCards.length,
          contextSnippetCount: contextSnippets.length
        }
      });
      const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
        {
          apiKey: context.openAiApiKey,
          schemaName: "writer_agent_draft",
          jsonSchema: WRITER_RESPONSE_JSON_SCHEMA,
          messages: [
            {
              role: "system",
              content:
                "You are a precise writing assistant. Follow instructions exactly, keep output high signal, and avoid filler."
            },
            {
              role: "user",
              content: JSON.stringify({
                instruction: input.instruction,
                format,
                audience,
                tone,
                maxWords,
                contextSnippets,
                sourceCards
              })
            }
          ]
        },
        WriterResponseSchema
      );
      await maybeRecordUsage(context, diagnostic.usage);

      if (diagnostic.result) {
        await emitWriterStageEvent({
          context,
          stage: "structured_attempt",
          status: "completed",
          payload: {
            attempts: diagnostic.attempts ?? 1,
            wordCount: countWords(diagnostic.result.content)
          }
        });
        draft = {
          ...diagnostic.result,
          content: clipWords(diagnostic.result.content, maxWords)
        };
        fallbackUsed = false;
        fallbackReason = "none";
        draftQuality = "complete";
      } else {
        await emitWriterStageEvent({
          context,
          stage: "structured_attempt",
          status: "failed",
          payload: {
            attempts: diagnostic.attempts ?? 1,
            failureCode: diagnostic.failureCode ?? "unknown",
            failureClass: diagnostic.failureClass ?? "unknown",
            failureMessage: diagnostic.failureMessage ?? null
          }
        });
        fallbackUsed = true;
        fallbackReason = diagnostic.failureCode ?? "llm_failure";
        failureMessage = diagnostic.failureMessage ?? null;
        await emitWriterStageEvent({
          context,
          stage: "compact_retry",
          status: "started",
          payload: {
            maxWords,
            format
          }
        });
        const compactRetryDraft = await runCompactRetryDraft({
          apiKey: context.openAiApiKey,
          instruction: input.instruction,
          format,
          audience,
          tone,
          maxWords,
          sourceCards,
          contextSnippets
        });
        compactRetryUsed = true;
        if (compactRetryDraft) {
          await emitWriterStageEvent({
            context,
            stage: "compact_retry",
            status: "completed",
            payload: {
              wordCount: countWords(compactRetryDraft.content)
            }
          });
          draft = compactRetryDraft;
          failureMessage = null;
          fallbackReason = `${fallbackReason}_compact_retry_recovered`;
          draftQuality = "complete";
        } else {
          await emitWriterStageEvent({
            context,
            stage: "compact_retry",
            status: "failed",
            payload: {
              reason: "empty_or_short_response"
            }
          });
          draft = buildFallbackDraft({
            reason: diagnostic.failureMessage ?? diagnostic.failureCode ?? "structured model call failed",
            instruction: input.instruction,
            format,
            audience,
            tone,
            maxWords,
            contextSnippets,
            sourceCards
          });
        }
      }
    } else {
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
    const allowPlaceholderWrite = !context.openAiApiKey;
    if (input.outputPath && (draftQuality === "complete" || allowPlaceholderWrite)) {
      await emitWriterStageEvent({
        context,
        stage: "persist",
        status: "started",
        payload: {
          outputPath: input.outputPath,
          draftQuality
        }
      });
      try {
        const absoluteOutput = resolvePathInProject(context.projectRoot, input.outputPath);
        await mkdir(path.dirname(absoluteOutput), { recursive: true });
        const shouldOverwrite = input.overwrite !== false;
        if (!shouldOverwrite) {
          try {
            await readFile(absoluteOutput, "utf8");
            throw new Error("output file already exists and overwrite=false");
          } catch (error) {
            if (error instanceof Error && error.message.includes("overwrite=false")) {
              throw error;
            }
          }
        }
        await writeFile(absoluteOutput, `${draft.title}\n\n${draft.content}\n`, "utf8");
        writtenPath = toProjectRelative(context.projectRoot, absoluteOutput);
        await emitWriterStageEvent({
          context,
          stage: "persist",
          status: "completed",
          payload: {
            outputPath: writtenPath,
            wordCount: countWords(draft.content)
          }
        });
      } catch (error) {
        await emitWriterStageEvent({
          context,
          stage: "persist",
          status: "failed",
          payload: {
            outputPath: input.outputPath,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    } else if (input.outputPath) {
      await emitWriterStageEvent({
        context,
        stage: "persist",
        status: "skipped",
        payload: {
          outputPath: input.outputPath,
          reason: "draft_not_writable",
          draftQuality
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
      outputPath: writtenPath
    };
  }
};
