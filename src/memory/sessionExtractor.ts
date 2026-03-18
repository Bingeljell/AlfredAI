import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runOpenAiStructuredChat } from "../services/openAiClient.js";
import { ensureDir } from "../utils/fs.js";

const NoteSchema = z.object({
  category: z.enum(["Research", "Lead", "Decision", "Project"]),
  title: z.string().max(120),
  body: z.string().max(2000),
  tags: z.array(z.string().max(40)).max(6).optional()
});

const ExtractionOutputSchema = z.object({
  notes: z.array(NoteSchema).max(5)
});

type Note = z.infer<typeof NoteSchema>;

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function extractAndSaveSessionNotes(options: {
  workspaceDir: string;
  sessionId: string;
  message: string;
  assistantText: string;
  openAiApiKey?: string;
}): Promise<void> {
  const { workspaceDir, message, assistantText, openAiApiKey } = options;

  if (!openAiApiKey) return;
  // Skip trivially short exchanges — no facts worth persisting
  if (!assistantText || assistantText.trim().length < 80) return;

  const result = await runOpenAiStructuredChat(
    {
      apiKey: openAiApiKey,
      model: "gpt-4o-mini",
      timeoutMs: 15_000,
      schemaName: "session_notes",
      jsonSchema: z.toJSONSchema(ExtractionOutputSchema) as Record<string, unknown>,
      messages: [
        {
          role: "system",
          content: `Extract factual notes worth remembering in future sessions from this conversation. Only extract genuinely useful facts — skip greetings, clarifications, and meta-discussion. Output 0–5 notes.

Categories:
- Research: topics researched, findings, key facts, source URLs
- Lead: companies or contacts found, extraction quality observations
- Decision: user preferences, corrections the user gave Alfred, explicit choices made
- Project: active objectives, goals, deadlines, project context`
        },
        {
          role: "user",
          content: `User message:\n${message.slice(0, 1200)}\n\nAlfred response:\n${assistantText.slice(0, 2500)}`
        }
      ]
    },
    ExtractionOutputSchema
  );

  if (!result?.notes?.length) return;

  const dateStr = new Date().toISOString().slice(0, 10);

  await Promise.all(
    result.notes.map(async (note: Note) => {
      const slug = toSlug(note.title);
      const filePath = path.join(workspaceDir, "knowledge", note.category, `${dateStr}-${slug}.md`);
      await ensureDir(path.dirname(filePath));

      const tagsLine = note.tags?.length ? `tags: [${note.tags.map((t) => `"${t}"`).join(", ")}]` : "";
      const content = [
        "---",
        `title: "${note.title.replace(/"/g, "'")}"`,
        `category: ${note.category}`,
        `date: ${dateStr}`,
        ...(tagsLine ? [tagsLine] : []),
        "---",
        "",
        note.body,
        ""
      ].join("\n");

      await writeFile(filePath, content, "utf8");
    })
  );
}
