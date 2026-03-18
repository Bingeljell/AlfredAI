# Alfred Expansion Roadmap

> Last updated: 2026-03-18

## Core Status

The March 17 native tool-calling rewrite is stable. The core (orchestrator → agentLoop → specialists) is clean, the tool system is fully pluggable (drop a `.tool.ts`, auto-discovered), and the HTTP gateway is functional. The system is ready to expand outward.

---

## Tracks (in priority order)

### 1. Second Brain (QMD Memory)

**Problem:** Daily notes are written to `knowledge/Daily/YYYY/MM/DD.md` but never read. Alfred has no memory of prior research, leads, or user decisions across sessions.

**Design:**

```
Session ends
    │
    ▼
[session_extractor] — LLM call, extracts facts from run events
    │
    ▼  writes structured Markdown notes
knowledge/
  Research/   ← topics researched, findings, sources
  Leads/      ← companies found, extraction quality notes
  Decisions/  ← user preferences, corrections given to Alfred
  Projects/   ← per-project context, objectives
    │
    ▼  QMD indexes all *.md files
    │
    ▼
[rag_memory_query tool] → calls `qmd query "..."` → returns ranked chunks
```

**What QMD provides:** Hybrid local search (BM25 keyword + vector embeddings + LLM reranking) over Markdown files, all on-device with no API keys. Built by Tobias Lütke (Shopify CEO), used in Shopify's monorepo. Install via `npm install -g @tobilu/qmd`.

**Files to create/modify:**
- `src/memory/sessionExtractor.ts` — post-session LLM call writing structured notes
- `src/agent/tools/definitions/ragMemoryQuery.tool.ts` — wraps `qmd query` CLI
- `src/core/runReActLoop.ts` — trigger session extractor after each run
- `src/core/specialists.ts` — add `rag_memory_query` to allowlists + system prompt hint

---

### 2. Video Clipper Tool (Quick Win)

**Problem:** No way to ask Alfred to edit video files from bike rides or other recordings.

**Design:** Thin wrapper around the `videoclipper` CLI (`github.com/Bingeljell/videoclipper`).

```typescript
// src/agent/tools/definitions/videoClipper.tool.ts
Input: { videoPath, instruction, outputPath? }
// "clip the steep descent starting at 1:23, 30 seconds"
Execute: shell call to videoclipper binary with parsed args
Output: { outputPath, duration, status }
```

Routes to `ops` specialist. Assumption: `videoclipper` binary on PATH.

---

### 3. Self-Awareness (Dev Specialist)

**Problem:** Alfred can't improve itself. New tools and bug fixes require a human developer session.

**Goal:** Alfred-as-Claude-Code — given "build a tool that does X" or "fix this bug", Alfred reads the codebase, writes code, runs tsc, runs tests, and commits.

**Design:**

```
User: "Build a tool that calls the video clipper CLI"
    │
    ▼
Orchestrator → "dev" specialist (new)
    │
    ▼
Reads: src/agent/tools/definitions/search.tool.ts  (pattern reference)
       src/agent/types.ts                           (tool contract)
       src/core/specialists.ts                      (allowlist to update)
    │
    ▼
Writes: src/agent/tools/definitions/videoClipper.tool.ts
Runs:   tsc --noEmit  →  node --test  →  git commit
```

**Dev specialist config:**
- Tools: `file_read`, `file_list`, `file_write`, `file_edit`, `shell_exec`, `rag_memory_query`
- Model: `gpt-4o`, maxIterations: 25
- System prompt embeds: tool definition contract, specialist pattern, Zod usage, AGENTS.md conventions, compact `src/` file map
- Safety: `git push` requires `requiresApproval: true` (enforced, not just flagged)

**Files to create/modify:**
- `src/core/specialists.ts` — add `DEV_SPECIALIST`
- `src/core/orchestrator.ts` — add heuristic: `build/create/add/fix/refactor + tool/skill/feature/bug → "dev"`
- `src/agent/tools/definitions/shellExec.tool.ts` — enforce approval for `git push`

---

### 4. Conversational Channels (WhatsApp + Telegram)

**Problem:** Alfred is only accessible via the web UI. Goal: chat with Alfred from anywhere.

**Design:** Channel adapters translate platform webhooks → `/v1/chat/turn`, poll for result, push response back.

```
Incoming message (Telegram / WhatsApp)
    │
    ▼
src/channels/{platform}/adapter.ts
    │  POST /v1/chat/turn
    ▼
Alfred runs (async, up to 10 min)
    │  GET /v1/runs/:runId  (internal poll)
    ▼
Adapter sends response back to platform
```

**Platform choices:**
- **Telegram**: Official Bot API via `node-telegram-bot-api`. Free, reliable, no approval needed. Env: `TELEGRAM_BOT_TOKEN`.
- **WhatsApp**: Twilio Programmable Messaging (stable, per-message cost). Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`.

**Channel adapters are optional** — they start only if the relevant env vars are present. No-op otherwise.

**Async UX:** For long-running tasks (lead gen, research), send "Working on it..." after 10s, then final response when done.

**Files to create/modify:**
- `src/channels/types.ts` — `ChannelAdapter` interface
- `src/channels/telegram/adapter.ts`
- `src/channels/whatsapp/adapter.ts`
- `src/gateway/server.ts` — conditional channel startup
- `src/config/env.ts` — add channel env vars

---

### 5. Open Source Packaging

**Problem:** Alfred has no Docker setup, no installation path, and no contributor guide.

**Distribution model:** Open source self-host first. Hosted tier later once major features stabilize.

**Steps:**
1. **Dockerfile + docker-compose** — Alfred + Searxng sidecar, workspace and knowledge volumes mounted
2. **`.env.example`** — all 45 env vars with comments, sensitive keys clearly marked
3. **`README.md`** — quickstart for both Docker and direct Node.js paths
4. **`CONTRIBUTING.md`** — points to AGENTS.md conventions
5. **GitHub Actions CI** — `tsc --noEmit` + unit tests on PR; Docker build on merge to main
6. **`alfred.config.json`** support — optional config file that overrides env vars (for users who prefer it)

---

## Execution Order

| Order | Track | Rationale |
|---|---|---|
| 1 | Second brain (QMD) | Foundational — all other tracks benefit from memory |
| 2 | Video clipper tool | Quick win, validates tool extensibility pattern |
| 3 | Self-awareness (dev specialist) | Multiplies iteration speed for all subsequent work |
| 4 | Channels | Needs stable core + memory first |
| 5 | Open source packaging | Last — done when major features are in |

---

## Verification Checklist

- **Second brain**: Ask Alfred about a topic researched in a prior session → `rag_memory_query` should return relevant chunks before web search fires
- **Dev specialist**: Ask Alfred to "add a tool that returns the current time" → verify it writes the file, runs tsc clean, tool appears on next server start
- **Channels**: Send a message from WhatsApp/Telegram → receive a response with correct session continuity
- **Video clipper**: "Clip the first 30 seconds of ~/rides/mar18.mp4" → verify output file exists at expected path
- **Packaging**: Fresh clone + `docker compose up` → Alfred running with no manual steps beyond `.env` configuration
