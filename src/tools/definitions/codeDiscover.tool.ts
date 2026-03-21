import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolvePathInProject, toProjectRelative } from "../helpers/pathSafety.js";

export const CodeDiscoverToolInputSchema = z.object({
  path: z.string().min(1).max(600).default("."),
  pattern: z.string().min(1).max(200),
  type: z.enum(["exact", "regex", "function", "class", "export"]).default("regex"),
  isCaseSensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(20),
  fileExtension: z.string().optional()
});

interface MatchResult {
  file: string;
  line: number;
  content: string;
}

function buildRegex(pattern: string, type: string, isCaseSensitive: boolean): RegExp {
  const flags = isCaseSensitive ? "g" : "gi";
  let regexStr = pattern;

  if (type === "exact") {
    regexStr = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  } else if (type === "function") {
    // Matches: function foo, foo = function, foo: function, foo = () =>
    regexStr = `(?:function\\s+${pattern}\\b|\\b${pattern}\\s*[:=]\\s*(?:function|\\(.*\\)\\s*=>|async\\s))`;
  } else if (type === "class") {
    regexStr = `class\\s+${pattern}\\b`;
  } else if (type === "export") {
    regexStr = `export\\s+(?:const|let|var|function|class|type|interface)\\s+${pattern}\\b`;
  }

  return new RegExp(regexStr, flags);
}

export const toolDefinition: ToolDefinition<typeof CodeDiscoverToolInputSchema> = {
  name: "code_discover",
  description: "Navigate the codebase by performing semantic and regex-based discovery of functions, classes, exports, and patterns.",
  inputSchema: CodeDiscoverToolInputSchema,
  inputHint: "Use to find where a function is defined, a class is declared, or where a pattern occurs across files.",
  async execute(input, context) {
    const rootPath = resolvePathInProject(context.projectRoot, input.path ?? ".");
    const regex = buildRegex(input.pattern, input.type ?? "regex", input.isCaseSensitive ?? false);
    const limit = input.limit ?? 20;

    const results: MatchResult[] = [];
    const queue: string[] = [rootPath];

    while (queue.length > 0 && results.length < limit) {
      const current = queue.shift();
      if (!current) break;

      let st;
      try {
        st = await stat(current);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        try {
          const entries = await readdir(current, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
              continue;
            }
            queue.push(path.join(current, entry.name));
          }
        } catch {
          // Ignore unreadable directories
        }
      } else if (st.isFile()) {
        if (input.fileExtension && !current.endsWith(input.fileExtension)) {
          continue;
        }

        try {
          const content = await readFile(current, "utf-8");
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            regex.lastIndex = 0;
            if (regex.test(line)) {
              results.push({
                file: toProjectRelative(context.projectRoot, current),
                line: i + 1,
                content: line.trim()
              });
              if (results.length >= limit) {
                break;
              }
            }
          }
        } catch {
          // Skip unreadable or non-text files
        }
      }
    }

    return {
      searchedPath: toProjectRelative(context.projectRoot, rootPath),
      patternUsed: regex.source,
      matchesFound: results.length,
      limitReached: results.length >= limit,
      results
    };
  }
};
