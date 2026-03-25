# Repo Guidelines

---

## For Alfred — Codebase Map

This section is written for Alfred. When you are doing self-development work (reading your own code, proposing changes, writing new tools), use this as your orientation guide.

### Key files
| File | Purpose |
|------|---------|
| `src/runtime/specialists.ts` | Your identity, system prompt, and tool allowlist |
| `src/runtime/agentLoop.ts` | The main loop that drives your reasoning and tool calls |
| `src/tools/types.ts` | Core TypeScript interfaces (`ToolContext`, `ToolState`, `ToolDefinition`) |
| `src/tools/registry.ts` | Auto-discovers and loads all tool files; handles input repair |
| `src/tools/definitions/` | **Where all tool files live** — one file per tool, named `<toolName>.tool.ts` |
| `src/runner/chatService.ts` | Handles turn execution, session context, conversation window |
| `src/memory/sessionStore.ts` | Session working memory and summaries |
| `src/memory/groupChatStore.ts` | Daily chat logs per channel group |
| `src/config/env.ts` | All environment config via Zod schema |
| `SOUL.md` | Your identity and values |
| `AGENTS.md` | This file — codebase conventions |

### How tools work

Tools are auto-discovered: the registry reads every `*.tool.ts` file in `src/tools/definitions/` and expects a named export `toolDefinition`.

Every tool file exports one thing:
```typescript
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({
  // your fields here
});

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "your_tool_name",
  description: "One sentence describing what this tool does and when to call it.",
  inputSchema: InputSchema,
  inputHint: '{"field": "example"}',
  async execute(input, context) {
    // context.state — shared agent state (artifacts, fetchedPages, etc.)
    // context.searchManager — run searches
    // context.runStore — append events
    // context.deadlineAtMs — check before long operations
    return { result: "..." };
  }
};
```

To make a new tool available to yourself, also add its name to the `toolAllowlist` array in `src/runtime/specialists.ts`.

### Type-checking
```bash
pnpm tsc --noEmit
```
Run this after any code change before proposing a commit.

### Committing
```bash
scripts/committer "your commit message" "file1" "file2"
```
Always use `scripts/committer` — never `git add`/`git commit` directly. Work on feature branches; never commit to `main` unless explicitly instructed. If `main` is required, use:
```bash
scripts/committer --allow-main "your commit message" "file1" "file2"
```
Commit only — do not push without explicit instruction.

---

## Output paths

When calling `writer_agent`, do not specify `outputPath` — the default saves to the correct location:
```
workspace/alfred/sessions/{sessionId}/artifacts/{runId}-{format}.md
```
Specifying a bare filename (e.g. `"report.md"`) will write to the repo root. Use the default.

When using `file_write` directly, write under `workspace/alfred/` — never to the project root.

## Temporal queries

When a query involves "latest", "recent", "current", or an implied year, do not embed a year in your search query without first confirming the current date. The current date is injected at the top of your system prompt — use it.

---

## Efficiency Principles

**Minimise LLM calls — they are the scarcest resource.**
Every tool call costs one LLM iteration. Prefer fewer, well-targeted calls over many exploratory ones.

- Form a hypothesis first, then read to confirm it — don't read to discover
- Use `code_discover` over multiple `shell_exec` greps; one call beats five
- Read files in large chunks (up to 800 lines) rather than multiple 100-line passes
- Avoid `git diff` and `git log -p` — they dump full file content into context;
  use `git log --oneline` or `git show --stat` instead
- Once you have enough context to act, act — one more read rarely changes the answer

---

## Memory Architecture

Alfred's memory has three tiers:

### 1. Within-session (conversation window)
The last 15 turns of the current session are injected as real message pairs into every run, giving you full in-session continuity without amnesia. This is handled automatically — you do not need to read any files.

### 2. Group chat log (daily)
Every turn is appended to a daily JSONL log file per channel group:
```
workspace/alfred/groups/{channelKey}/logs/YYYY/MM/YYYY-MM-DD.jsonl
```
Use `file_read` on this file when Nikhil references something from earlier today that isn't in your conversation window.

### 3. Group daily summaries (on-demand)
When asked to summarise a day, write a markdown file:
```
workspace/alfred/groups/{channelKey}/summaries/YYYY/MM/YYYY-MM-DD.md
```
Include: what was worked on, key outcomes, artifacts created, open threads. Nikhil will ask you to generate these explicitly.

---

## Changelog Discipline
- Add an entry to `docs/changelog.md` in the same commit for every meaningful change.
- Format: `- **YYYY-MM-DD** > \`file(s)\` > short description of what changed and why`

## Testing Workflow
- Run `pnpm tsc --noEmit` after every code change.
- Before each commit, run all available automated tests relevant to changed files.

## Commit Workflow
- Always commit using `scripts/committer "message" "file1" "file2"`.
- Do not use direct `git add` / `git commit` unless explicitly asked.
- Never commit to `main` unless explicitly instructed — use `--allow-main` flag if so.
- Do not push without explicit instruction.
