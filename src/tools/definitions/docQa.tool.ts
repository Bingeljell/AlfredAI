import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmUsage } from "../../types.js";
import { runOpenAiStructuredChatWithDiagnostics } from "../../provider/openai-http.js";
import type { LeadAgentToolDefinition } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";

const DOC_FILE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".json", ".yaml", ".yml"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".pnpm-store"]);
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "this",
  "from",
  "what",
  "when",
  "where",
  "which",
  "into",
  "your",
  "have",
  "will"
]);

const DocQaToolInputSchema = z.object({
  question: z.string().min(4).max(1000),
  scopePaths: z.array(z.string().min(1).max(600)).max(10).optional(),
  maxFiles: z.number().int().min(1).max(20).optional(),
  maxSnippets: z.number().int().min(1).max(24).optional(),
  maxCharsPerFile: z.number().int().min(500).max(40_000).optional()
});

interface SnippetMatch {
  source: string;
  text: string;
  score: number;
}

const DOC_QA_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 5000 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needsMoreContext: { type: "boolean" },
    citations: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", minLength: 1, maxLength: 300 },
          rationale: { type: "string", minLength: 1, maxLength: 240 }
        },
        required: ["source", "rationale"]
      }
    }
  },
  required: ["answer", "confidence", "needsMoreContext", "citations"]
} as const;

const DocQaResponseSchema = z.object({
  answer: z.string().min(1).max(5000),
  confidence: z.number().min(0).max(1),
  needsMoreContext: z.boolean(),
  citations: z
    .array(
      z.object({
        source: z.string().min(1).max(300),
        rationale: z.string().min(1).max(240)
      })
    )
    .max(12)
});

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
    )
  );
}

function countTokenHits(content: string, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const lower = content.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) {
      score += 1;
    }
  }
  return score;
}

async function collectTextFiles(rootPath: string, collected: string[], limit = 500): Promise<void> {
  if (collected.length >= limit) {
    return;
  }
  const rootStat = await stat(rootPath);
  if (rootStat.isFile()) {
    const extension = path.extname(rootPath).toLowerCase();
    if (DOC_FILE_EXTENSIONS.has(extension)) {
      collected.push(rootPath);
    }
    return;
  }

  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (collected.length >= limit) {
      return;
    }
    const nextPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await collectTextFiles(nextPath, collected, limit);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (DOC_FILE_EXTENSIONS.has(extension)) {
      collected.push(nextPath);
    }
  }
}

function buildSnippetsForFile(args: {
  content: string;
  relativePath: string;
  tokens: string[];
  maxSnippetsPerFile: number;
}): SnippetMatch[] {
  const lines = args.content.split("\n");
  const snippets: SnippetMatch[] = [];
  const normalizedTokens = args.tokens;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lower = line.toLowerCase();
    let hitCount = 0;
    for (const token of normalizedTokens) {
      if (lower.includes(token)) {
        hitCount += 1;
      }
    }
    if (hitCount === 0) {
      continue;
    }

    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length, index + 3);
    const windowText = lines.slice(start, end).join("\n").trim();
    if (!windowText) {
      continue;
    }
    snippets.push({
      source: `${args.relativePath}:${index + 1}`,
      text: windowText.slice(0, 900),
      score: hitCount
    });
    if (snippets.length >= args.maxSnippetsPerFile) {
      break;
    }
  }
  return snippets;
}

function buildFallbackAnswer(question: string, snippets: SnippetMatch[]): string {
  if (snippets.length === 0) {
    return `I couldn't find strong matches for: "${question}". Provide narrower scopePaths or better keywords.`;
  }
  const preview = snippets
    .slice(0, 3)
    .map((item) => `- [${item.source}] ${item.text.replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");
  return `Using local docs only, here are the strongest matching excerpts for "${question}":\n${preview}`;
}

async function maybeRecordUsage(context: Parameters<LeadAgentToolDefinition["execute"]>[1], usage: LlmUsage | undefined): Promise<void> {
  if (!usage) {
    return;
  }
  await context.runStore.addLlmUsage(context.runId, usage, 1);
}

export const toolDefinition: LeadAgentToolDefinition<typeof DocQaToolInputSchema> = {
  name: "doc_qa",
  description: "Answer questions from local documentation/files with citations and bounded context.",
  inputSchema: DocQaToolInputSchema,
  inputHint: "Use for repo/docs questions before coding; pass scopePaths to narrow search.",
  async execute(input, context) {
    const scopeInputs = input.scopePaths && input.scopePaths.length > 0 ? input.scopePaths : ["docs"];
    const maxFiles = input.maxFiles ?? 8;
    const maxSnippets = input.maxSnippets ?? 10;
    const maxCharsPerFile = input.maxCharsPerFile ?? 14_000;
    const questionTokens = tokenize(input.question);

    const files: string[] = [];
    for (const scopePath of scopeInputs) {
      try {
        const absolute = resolvePathInProject(context.projectRoot, scopePath);
        await collectTextFiles(absolute, files, 600);
      } catch {
        continue;
      }
    }

    const uniqueFiles = Array.from(new Set(files));
    const scoredFiles: Array<{ relativePath: string; content: string; score: number }> = [];

    for (const absolutePath of uniqueFiles) {
      const raw = await readFile(absolutePath, "utf8");
      if (!raw.trim()) {
        continue;
      }
      const content = raw.slice(0, maxCharsPerFile);
      const relativePath = toProjectRelative(context.projectRoot, absolutePath);
      const nameScore = countTokenHits(relativePath, questionTokens);
      const bodyScore = countTokenHits(content, questionTokens);
      const score = bodyScore * 3 + nameScore;
      if (score <= 0) {
        continue;
      }
      scoredFiles.push({
        relativePath,
        content,
        score
      });
    }

    scoredFiles.sort((a, b) => b.score - a.score);
    const selectedFiles = scoredFiles.slice(0, maxFiles);

    const snippets = selectedFiles
      .flatMap((file) =>
        buildSnippetsForFile({
          content: file.content,
          relativePath: file.relativePath,
          tokens: questionTokens,
          maxSnippetsPerFile: 3
        })
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSnippets);

    if (snippets.length === 0) {
      return {
        question: input.question,
        answer: `No relevant snippets found in scope paths: ${scopeInputs.join(", ")}`,
        confidence: 0,
        needsMoreContext: true,
        citations: [],
        filesScanned: uniqueFiles.length,
        filesUsed: 0,
        snippetCount: 0,
        fallbackUsed: true,
        fallbackReason: "no_matching_snippets"
      };
    }

    if (!context.openAiApiKey) {
      return {
        question: input.question,
        answer: buildFallbackAnswer(input.question, snippets),
        confidence: 0.35,
        needsMoreContext: true,
        citations: snippets.slice(0, 6).map((item) => ({
          source: item.source,
          rationale: "keyword overlap"
        })),
        filesScanned: uniqueFiles.length,
        filesUsed: selectedFiles.length,
        snippetCount: snippets.length,
        fallbackUsed: true,
        fallbackReason: "missing_api_key"
      };
    }

    const promptContext = snippets
      .map((snippet, index) => `[#${index + 1}] ${snippet.source}\n${snippet.text}`)
      .join("\n\n");

    const diagnostic = await runOpenAiStructuredChatWithDiagnostics(
      {
        apiKey: context.openAiApiKey,
        schemaName: "doc_qa_answer",
        jsonSchema: DOC_QA_RESPONSE_JSON_SCHEMA,
        messages: [
          {
            role: "system",
            content:
              "You answer documentation questions strictly from provided snippets. Be precise, cite sources, and say when evidence is incomplete."
          },
          {
            role: "user",
            content: `Question:\n${input.question}\n\nSnippets:\n${promptContext}`
          }
        ]
      },
      DocQaResponseSchema
    );
    await maybeRecordUsage(context, diagnostic.usage);

    if (!diagnostic.result) {
      return {
        question: input.question,
        answer: buildFallbackAnswer(input.question, snippets),
        confidence: 0.3,
        needsMoreContext: true,
        citations: snippets.slice(0, 6).map((item) => ({
          source: item.source,
          rationale: "keyword overlap"
        })),
        filesScanned: uniqueFiles.length,
        filesUsed: selectedFiles.length,
        snippetCount: snippets.length,
        fallbackUsed: true,
        fallbackReason: diagnostic.failureCode ?? "llm_failure",
        failureMessage: diagnostic.failureMessage ?? null
      };
    }

    return {
      question: input.question,
      answer: diagnostic.result.answer,
      confidence: diagnostic.result.confidence,
      needsMoreContext: diagnostic.result.needsMoreContext,
      citations: diagnostic.result.citations,
      filesScanned: uniqueFiles.length,
      filesUsed: selectedFiles.length,
      snippetCount: snippets.length,
      fallbackUsed: false
    };
  }
};

