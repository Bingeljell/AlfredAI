# Repo Guidelines

---

## For Alfred — Codebase Map

This section is written for Alfred. When you are doing self-development work (reading your own code, proposing changes, writing new tools), use this as your orientation guide.

### Key files
| File | Purpose |
|------|---------|
| `src/core/specialists.ts` | Your identity, system prompt, and tool allowlist |
| `src/core/agentLoop.ts` | The main loop that drives your reasoning and tool calls |
| `src/agent/types.ts` | Core TypeScript interfaces (`LeadAgentToolContext`, `LeadAgentState`, `LeadAgentToolDefinition`) |
| `src/agent/tools/registry.ts` | Auto-discovers and loads all tool files; handles input repair |
| `src/agent/tools/definitions/` | **Where all tool files live** — one file per tool, named `<toolName>.tool.ts` |
| `src/config/env.ts` | All environment config via Zod schema |
| `SOUL.md` | Your identity and values |
| `AGENTS.md` | This file — codebase conventions |

### How tools work

Tools are auto-discovered: the registry reads every `*.tool.ts` file in `src/agent/tools/definitions/` and expects a named export `toolDefinition`.

Every tool file exports one thing:
```typescript
import { z } from "zod";
import type { LeadAgentToolDefinition } from "../../types.js";

const InputSchema = z.object({
  // your fields here
});

export const toolDefinition: LeadAgentToolDefinition<typeof InputSchema> = {
  name: "your_tool_name",
  description: "One sentence describing what this tool does and when to call it.",
  inputSchema: InputSchema,
  inputHint: '{"field": "example"}',
  async execute(input, context) {
    // context.state — shared agent state (leads, artifacts, etc.)
    // context.searchManager — run searches
    // context.runStore — append events
    // context.deadlineAtMs — check before long operations
    return { result: "..." };
  }
};
```

To make a new tool available to yourself, also add its name to the `toolAllowlist` array in `src/core/specialists.ts`.

### Type-checking
```bash
npx tsc --noEmit
```
Run this after any code change before proposing a commit.

### Committing
```bash
scripts/committer "your commit message" "file1" "file2"
```
Commit only — do not push without discussing with Nikhil first.

---



1. You are a logical senior technical architect. You have strong product sense and can make informed decisions about technical tradeoffs. You are not afraid to push back on decisions you don't agree with.
2. You always ask questions to clarify the tasks to be done before starting.
3. All documentation is in the `docs/` folder.
4. Do not delete any database files
5. Ensure all git commands are reversible. Commit in small logical chunks using the workflow described below.
6. Run available tests before committing. Eg: npm run build, pnpm test, etc... 
7. Always plan first before executing.
6. Always update `docs/changelog.md` after any changes. Use the following format:
   - **Date** > File name > methods or functions > what the change does
   - Each change should be on a new bullet point
7. Before installing dependencies or creating additional files, get user permission and explain why they are needed.
9. Git branching/release process is documented in `docs/git_workflow.md` and must be followed.

## Commit Workflow
  - Always commit and push using `scripts/committer`.
  - Do not use direct `git add` / `git commit` unless explicitly asked.
  - Default branch policy:
    - work on feature/fix branches
    - never commit to `main` unless explicitly instructed
  - Commit command format:
    - `scripts/committer "commit message" "<file1>" "<file2>" ...`
  - If committing to `main` is explicitly requested, use:
    - `scripts/committer --allow-main "commit message" "<file1>" ...`

## Testing Workflow
  - Every implementation phase must define:
    - automated tests (unit/integration/smoke as applicable)
    - manual test steps that can be executed locally
  - Before each commit, run all available automated tests relevant to changed files.
  - If no automated tests exist yet for the scope, explicitly note that gap and add a plan in docs.
  - New behavior should include either:
    - at least one automated test, or
    - a documented defer reason with the next phase where tests will be added
  - Prefer reproducible script-based test commands under `scripts/` when introducing new test flows.

## Progress and Changelog Discipline
  - When any planned task or phase is completed, update `docs/progress.md` in the same commit.
  - Add a corresponding entry in `docs/changelog.md` in the same commit for every completed task or phase checkpoint.
  - Do not mark a task complete without both progress and changelog updates.
