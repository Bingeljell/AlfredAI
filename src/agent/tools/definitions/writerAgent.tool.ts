import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmUsage } from "../../../types.js";
import { runOpenAiStructuredChatWithDiagnostics } from "../../../services/openAiClient.js";
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

function buildFallbackDraft(args: {
  instruction: string;
  format: string;
  audience: string;
  tone: string;
  maxWords: number;
  contextSnippets: string[];
  sourceCards: ResearchSourceCard[];
}): { title: string; content: string; summary: string; nextSteps: string[] } {
  const heading = `Draft: ${args.instruction.slice(0, 70)}`;
  const contextBlock =
    args.contextSnippets.length > 0
      ? `\n\nContext highlights:\n${args.contextSnippets.map((item) => `- ${item}`).join("\n")}`
      : "";
  const sourceBlock =
    args.sourceCards.length > 0
      ? `\n\nSource cards:\n${args.sourceCards
          .slice(0, 10)
          .map((card) => `- ${card.date ?? "date unknown"} | ${card.title ?? "Untitled"} | ${card.url}\n  Claim: ${card.claim}`)
          .join("\n")}`
      : "";
  const content = clipWords(
    [
      `Format: ${args.format}`,
      `Audience: ${args.audience}`,
      `Tone: ${args.tone}`,
      "",
      `Objective: ${args.instruction}`,
      "",
      "Draft:",
      `This is a structured first draft prepared without model generation because no API key was available.${contextBlock}${sourceBlock}`,
      "Expand this draft by refining claims, adding evidence, and tightening the call-to-action."
    ].join("\n"),
    args.maxWords
  );
  return {
    title: heading,
    content,
    summary: "Fallback draft generated without model output.",
    nextSteps: ["Review factual accuracy", "Refine messaging and tone", "Publish or share after edits"]
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

    if (context.openAiApiKey) {
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
        draft = {
          ...diagnostic.result,
          content: clipWords(diagnostic.result.content, maxWords)
        };
        fallbackUsed = false;
        fallbackReason = "none";
      } else {
        fallbackUsed = true;
        fallbackReason = diagnostic.failureCode ?? "llm_failure";
        failureMessage = diagnostic.failureMessage ?? null;
      }
    }

    let writtenPath: string | null = null;
    if (input.outputPath) {
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
      outputPath: writtenPath
    };
  }
};
