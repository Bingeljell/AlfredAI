import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const InputSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(80).describe("e.g. 'AI / Tools', 'Finance / Markets', 'Tech / Open Source'"),
  oneLiner: z.string().min(1).max(200).describe("One sentence — what this is and why it matters"),
  body: z.string().min(1).max(20_000).describe("The full markdown body Alfred has prepared"),
  tags: z.array(z.string().max(40)).max(8).optional(),
  action: z.enum(["bookmark", "summarise", "note"]).default("bookmark")
});

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

async function appendToIndex(
  linksDir: string,
  title: string,
  url: string,
  category: string,
  oneLiner: string,
  filePath: string,
  date: string
): Promise<void> {
  const indexPath = path.join(linksDir, "INDEX.md");
  const relPath = "./" + path.relative(linksDir, filePath);
  const entry = `\n---\n**[${title}](${relPath})** · \`${category}\` · ${date}  \n${oneLiner}  \n[→ Source](${url})\n`;
  let existing = "";
  try {
    existing = await readFile(indexPath, "utf8");
  } catch {
    existing = "# Alfred's Link Index\n\n_Saved links and bookmarks — searchable via `rag_memory_query`. Browse this file for a quick overview._\n";
  }
  await writeFile(indexPath, existing.trimEnd() + entry + "\n", "utf8");
}

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "save_link",
  description:
    "Persist a link to Alfred's knowledge base. Alfred provides the fully-prepared title, category, one-liner, and body — this tool handles file writing, INDEX.md, and QMD indexing. Always check for duplicates before saving.",
  inputSchema: InputSchema,
  inputHint:
    '{"url":"https://example.com","title":"Title","category":"AI / Tools","oneLiner":"What this is and why it matters.","body":"## Summary\\n- point 1\\n- point 2","tags":["ai","tools"],"action":"bookmark"}',

  async execute(input, context) {
    const today = new Date().toISOString().slice(0, 10);
    const yearMonth = today.slice(0, 7);
    const knowledgeDir = path.join(context.workspaceDir, "knowledge");
    const linksDir = path.join(knowledgeDir, "links");
    const monthDir = path.join(linksDir, yearMonth);

    // Duplicate check — execFile (no shell) with -F so the URL is matched
    // literally and never interpreted as a shell token or a regex.
    try {
      const { stdout } = await execFileAsync(
        "grep",
        ["-rlF", "--include=*.md", "--", `url: ${input.url}`, linksDir],
        { timeout: 5_000 }
      );
      const existing = stdout.trim().split("\n")[0];
      if (existing) {
        return { saved: false, duplicate: true, existingPath: existing };
      }
    } catch { /* no match (grep exit 1), missing links dir, etc. — treat as not a duplicate */ }

    // Write the link file
    const slug = slugify(input.title) || slugify(input.url);
    const filename = `${today}-${slug}.md`;
    await mkdir(monthDir, { recursive: true });
    const filePath = path.join(monthDir, filename);

    const fileContent = [
      "---",
      `url: ${input.url}`,
      `title: ${input.title}`,
      `category: ${input.category}`,
      `action: ${input.action}`,
      `saved: ${today}`,
      `tags: [${(input.tags ?? []).join(", ")}]`,
      "---",
      "",
      `# ${input.title}`,
      "",
      `**URL:** ${input.url}  `,
      `**Category:** ${input.category}  `,
      `**Saved:** ${today}`,
      "",
      `> ${input.oneLiner}`,
      "",
      input.body,
      "",
      "---",
      "_Saved by Alfred_",
      ""
    ].join("\n");

    await writeFile(filePath, fileContent, "utf8");
    const relativePath = path.relative(context.projectRoot, filePath);
    context.addArtifact(relativePath);

    // Update INDEX.md
    await appendToIndex(linksDir, input.title, input.url, input.category, input.oneLiner, filePath, today);

    // Re-index QMD
    let indexRefreshed = false;
    let indexError: string | undefined;
    try {
      await execAsync("qmd update && qmd embed", { cwd: knowledgeDir, timeout: 60_000 });
      indexRefreshed = true;
    } catch (e) {
      indexError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }

    return { saved: true, duplicate: false, filePath: relativePath, indexRefreshed, indexError };
  }
};
