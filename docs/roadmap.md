# Alfred Expansion Roadmap

> Last updated: 2026-03-18

## Core Status

The March 17 native tool-calling rewrite is stable. The core (orchestrator → agentLoop → specialists) is clean, the tool system is fully pluggable (drop a `.tool.ts`, auto-discovered), and the HTTP gateway is functional. The system is ready to expand outward.

---

## Tracks (in priority order)

### 0. Multi-Provider LLM Support ✅ Done

**Problem:** Every LLM call is hardcoded to OpenAI. Model names (`gpt-4o`, `gpt-4o-mini`) are hardcoded in `specialists.ts` and `orchestrator.ts`. Alfred can't use Claude, Gemini, or local open-source models, and users have no way to configure their preferred provider or models without changing code.

**What already exists:** `src/services/llm/` has a correct `LlmProvider` interface (`generateText`, `generateStructured`), an `OpenAiLlmProvider` implementation, and a `router.ts` with provider fallback logic. The problem is adoption — only `writerAgent` uses this abstraction. The agent loop, orchestrator, and session extractor all call `openAiClient.ts` directly.

**What's missing:**
1. `generateWithTools()` not in `LlmProvider` interface — native tool-calling is the core of `agentLoop.ts` and each provider has a different wire format
2. No `AnthropicLlmProvider`, `GeminiLlmProvider`, or `OllamaLlmProvider`
3. Model names not configurable — must change code to switch models
4. `agentLoop.ts` and `orchestrator.ts` bypass the provider abstraction entirely

**Tool-calling format differences:**

| Provider | Tool call format |
|---|---|
| OpenAI / Ollama | `tool_calls[].function.arguments` (JSON string) |
| Anthropic | `tool_use[].input` (JSON object) |
| Gemini | `functionCall[].args` (JSON object) |

Each provider implementation handles the translation internally — the agent loop sees a unified interface.

**`.env` additions:**
```bash
# Primary provider (openai | anthropic | gemini | ollama)
ALFRED_LLM_PROVIDER=openai

# Model roles — configurable without code changes
ALFRED_MODEL_FAST=gpt-4o-mini     # classification, session extractor, lead extraction
ALFRED_MODEL_SMART=gpt-4o         # specialist agent loops

# API keys — Alfred activates whichever providers have keys present
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_GEMINI_API_KEY=...
OLLAMA_BASE_URL=http://localhost:11434   # local / open-source models
```

Setting `ALFRED_MODEL_SMART=gpt-5` (or `claude-opus-4-6`, `gemini-2.0-flash`, etc.) propagates to all specialist loops with no code change.

**Setup wizard (first run):** When Alfred starts and detects no provider keys, it will prompt interactively to choose a provider and paste an API key. This is a first-run onboarding flow — fits naturally alongside Track 5 (open source packaging) but the env var mechanism works immediately.

**Implementation steps:**

1. **Extend `LlmProvider` interface** (`src/services/llm/types.ts`)
   - Add `generateWithTools(request: LlmToolCallRequest): Promise<LlmToolCallResult>`
   - Define unified `LlmToolDef`, `LlmToolCall`, `LlmConversationMessage` types (provider-agnostic)

2. **Update `OpenAiLlmProvider`** (`src/services/llm/openAiProvider.ts`)
   - Implement `generateWithTools` by delegating to `runOpenAiToolCallWithDiagnostics`

3. **Add `AnthropicLlmProvider`** (`src/services/llm/anthropicProvider.ts`)
   - Uses `@anthropic-ai/sdk`
   - Translates `tool_use` ↔ unified tool call format
   - Implements all three methods

4. **Add `GeminiLlmProvider`** (`src/services/llm/geminiProvider.ts`)
   - Uses `@google/genai` SDK
   - Translates `functionCall` ↔ unified format

5. **Add `OllamaLlmProvider`** (`src/services/llm/ollamaProvider.ts`)
   - Ollama exposes an OpenAI-compatible API — thin wrapper that sets `baseURL` to `OLLAMA_BASE_URL`
   - Reuses OpenAI wire format

6. **Wire env config** (`src/config/env.ts`)
   - Add `ALFRED_LLM_PROVIDER`, `ALFRED_MODEL_FAST`, `ALFRED_MODEL_SMART`, and provider API key vars
   - Build a `createLlmProviders()` factory that reads config and returns the active provider list

7. **Migrate `agentLoop.ts`** to use `provider.generateWithTools()` instead of `runOpenAiToolCallWithDiagnostics`

8. **Migrate `orchestrator.ts`** to use `provider.generateStructured()` instead of `runOpenAiStructuredChatWithDiagnostics`

9. **Migrate `sessionExtractor.ts`** to use `provider.generateStructured()`

10. **Pull model names from config** in `specialists.ts` — replace `"gpt-4o"` / `"gpt-4o-mini"` with `appConfig.modelSmart` / `appConfig.modelFast`

**Files to create/modify:**
- `src/services/llm/types.ts` — add tool-calling types
- `src/services/llm/openAiProvider.ts` — add `generateWithTools`
- `src/services/llm/anthropicProvider.ts` — new
- `src/services/llm/geminiProvider.ts` — new
- `src/services/llm/ollamaProvider.ts` — new
- `src/services/llm/registry.ts` — new: `createLlmProviders()` factory
- `src/config/env.ts` — add provider + model env vars
- `src/core/agentLoop.ts` — use provider abstraction
- `src/core/orchestrator.ts` — use provider abstraction
- `src/memory/sessionExtractor.ts` — use provider abstraction
- `src/core/specialists.ts` — pull model names from config

---

### 1. Second Brain (QMD Memory) ✅ Done

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
| 0 | Multi-provider LLM | ✅ Done — OpenAI / Anthropic / Gemini / Ollama, configured via `.env` |
| 1 | Second brain (QMD) | ✅ Done |
| 2 | Video clipper tool | Quick win, validates tool extensibility pattern |
| 3 | Self-awareness (dev specialist) | Multiplies iteration speed for all subsequent work |
| 4 | Channels | Needs stable core + memory first |
| 5 | Open source packaging | Last — done when major features are in |

---

## Verification Checklist

- **Multi-provider**: Set `ALFRED_LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` → run a research query → confirm Alfred responds using Claude. Set `ALFRED_MODEL_FAST=gpt-4o-mini` and `ALFRED_MODEL_SMART=gpt-4o` → verify correct models appear in run diagnostics.
- **Second brain**: Ask Alfred about a topic researched in a prior session → `rag_memory_query` should return relevant chunks before web search fires
- **Dev specialist**: Ask Alfred to "add a tool that returns the current time" → verify it writes the file, runs tsc clean, tool appears on next server start
- **Channels**: Send a message from WhatsApp/Telegram → receive a response with correct session continuity
- **Video clipper**: "Clip the first 30 seconds of ~/rides/mar18.mp4" → verify output file exists at expected path
- **Packaging**: Fresh clone + `docker compose up` → Alfred running with no manual steps beyond `.env` configuration
