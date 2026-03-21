import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";
import { OpenAiLlmProvider } from "../../provider/openai.js";
import { runTextWithFallback } from "../../provider/router.js";

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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export const toolDefinition: ToolDefinition<typeof WriterAgentToolInputSchema> = {
  name: "writer_agent",
  description: "Generate a user-facing draft from the current contract and evidence, then optionally persist it.",
  inputSchema: WriterAgentToolInputSchema,
  inputHint: '{"instruction":"Write the final deliverable","format":"notes","outputShapeHint":"ranked_list","maxWords":800}',
  async execute(input, context) {
    const format = input.format ?? "blog_post";
    const tone = input.tone ?? "clear and grounded";
    const audience = input.audience ?? "general";
    const maxWords = input.maxWords ?? 900;
    
    const snippets: string[] = [];
    if (input.contextPaths) {
      for (const reqPath of input.contextPaths) {
        try {
          const absolute = resolvePathInProject(context.projectRoot, reqPath);
          const raw = await readFile(absolute, "utf8");
          snippets.push(`${reqPath}: ${raw.slice(0, 1000)}`);
        } catch {
          // ignore missing
        }
      }
    }
    const sourceCards = context.getResearchSourceCards ? (context.getResearchSourceCards() ?? []) : [];
    
    const sourcesText = sourceCards.length > 0 
      ? `\nAvailable sources:\n${sourceCards.map((c, i) => `[S${i+1}] ${c.title || c.url} | ${c.url}`).join("\n")}` 
      : "";
    const snippetsText = snippets.length > 0
      ? `\nContext snippets:\n${snippets.join("\n")}`
      : "";

    const fetchedPages = context.getFetchedPages ? context.getFetchedPages() : [];
    const fetchedPagesText = fetchedPages.length > 0
      ? `\nFetched Pages:\n${fetchedPages.map((p, i) => `--- [Page ${i+1}] ${p.url} ---\n${p.text.slice(0, 3000)}`).join("\n\n")}`
      : "";
      
    const outputShape = input.outputShapeHint ?? format;
    const prompt = `Instruction: ${input.instruction}\nDeliverable shape: ${outputShape}\nFormat: ${format}\nTone: ${tone}\nAudience: ${audience}\nMax words: ${maxWords}${sourcesText}${snippetsText}${fetchedPagesText}`;

    const providers = context.llmProviders && context.llmProviders.length > 0 
      ? context.llmProviders 
      : (context.openAiApiKey ? [new OpenAiLlmProvider({ apiKey: context.openAiApiKey })] : []);
      
    if (providers.length === 0) {
      throw new Error("No writer LLM provider configured");
    }

    const result = await runTextWithFallback({
      providers,
      request: {
        timeoutMs: 45000,
        maxAttempts: 2,
        messages: [
          { role: "system", content: "You are a writing tool. Produce only the final requested deliverable body. Do not explain your process." },
          { role: "user", content: prompt }
        ]
      }
    });

    if (!result.content || countWords(result.content) < 5) {
      throw new Error("Writer failed to generate meaningful content.");
    }
    if (result.usage && context.runStore.addLlmUsage) {
      await context.runStore.addLlmUsage(context.runId, result.usage, 1);
    }

    const content = result.content.trim();
    const wordCount = countWords(content);
    const titleMatch = content.split("\n").find(line => line.trim().length > 0);
    const title = titleMatch ? titleMatch.replace(/^#+\s*/, "").slice(0, 160) : "Draft";

    let writtenPath: string | null = null;
    const resolvedOutputPath = input.outputPath ?? path.posix.join("workspace", "alfred", "sessions", context.sessionId, "artifacts", `${context.runId}-${format}.md`);
    
    const absoluteOutput = resolvePathInProject(context.projectRoot, resolvedOutputPath);
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    
    if (input.overwrite === false) {
      try {
         await readFile(absoluteOutput, "utf8");
         throw new Error("output file already exists and overwrite=false");
      } catch (err: any) {
         if (err.message.includes("overwrite=false")) throw err;
      }
    }
    
    await writeFile(absoluteOutput, `${title}\n\n${content}\n`, "utf8");
    writtenPath = toProjectRelative(context.projectRoot, absoluteOutput);
    context.addArtifact(writtenPath);

    return {
      title,
      content,
      summary: `Generated ${format} deliverable.`,
      nextSteps: ["Review content", "Adjust style if needed"],
      format,
      tone,
      audience,
      wordCount,
      contextSnippetCount: snippets.length,
      sourceCardCount: sourceCards.length,
      fetchedPageCount: fetchedPages.length,
      fallbackUsed: false,
      fallbackReason: "none",
      failureMessage: null,
      draftQuality: "complete",
      deliverableStatus: "complete",
      outputShape: input.outputShapeHint ?? format,
      processCommentaryDetected: false,
      providerUsed: result.providerUsed ?? result.provider,
      passCount: 1,
      persistedFallbackDraft: false,
      outputPath: writtenPath
    };
  }
};