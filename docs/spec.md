# Project Design Document  
**General-Purpose AI Agent: “Alfred”**  
**Version:** 2.2 (March 2026)  
**Owner:** Nikhil Shahane  
**Status:** Living blueprint – we execute against this

## 1. Vision & End Goal
We are building **Alfred** — your personal, always-on, general-purpose AI agent.  

Named after the OG butler: loyal, tireless, extremely capable, and low-key badass. Batman doesn’t exist without Alfred — and your empire doesn’t run without him either.

Alfred starts as a powerful lead-gen + productivity partner and evolves into a true **Second Brain** that:
- Runs 24/7 on your hardware (Raspberry Pi, VPS, DO droplet, or laptop)
- Handles multiple isolated sessions in parallel
- Uses ReAct reasoning for any task
- Controls your local machine when needed
- Self-improves by studying OSS repos
- Remembers everything forever in plain Markdown

## 2. Core Architecture – ReAct Agent Loop
Alfred runs the classic **ReAct (Reason + Act)** loop in every session:

1. **Thought** – Reasons in plain English.  
2. **Action** – Calls one or more tools (parallel when possible).  
3. **Observation** – Receives structured result.  
4. Repeat until **Final Answer** or human approval.

**Gateway/Orchestrator** runs all loops (one per session), picks the best model per task, and routes inline vs queued execution.

### 2.1 Conversation Handling Model
Alfred should behave like a continuous conversational agent, not a stateless form processor.

- **Live context first**:
  - Recent turns in the active session stay in raw conversational form and are passed directly into Alfred's loop.
  - Alfred should rely on recent chat the same way a strong frontier model handles an active conversation: no artificial amnesia for the last few turns.
- **Canonical brief only when execution begins**:
  - When Alfred decides to perform work, it produces a structured task brief from the live conversation.
  - That brief is the contract for downstream tools and specialist agents.
  - The brief must preserve explicit user requirements exactly; downstream systems cannot silently rewrite them.
- **Deterministic code validates, but does not interpret**:
  - Deterministic logic exists to preserve invariants (schema validity, budgets, safety, cancellation, persistence).
  - Deterministic helper functions must not become the source of truth for user intent.

### 2.2 Brief Preservation Rules
The canonical task brief is the stable execution contract for a run.

- Explicit user requirements are immutable unless the user relaxes them:
  - requested count
  - geography
  - company type / industry
  - email/contact requirements
  - size bands
  - output format
- Agentic freedom applies to tactics, not to rewriting the brief:
  - search phrasing
  - tool choice
  - retry strategy
  - breadth vs depth sequencing
  - when to stop and report blockage
- Evaluation happens against the preserved brief, not against planner-invented targets.

### 2.3 Single-Agent with Tool Allowlist
Alfred is one agent. There is no classifier, no routing layer, and no specialist sub-agents. The model self-routes via a unified system prompt that covers all task types (research, writing, lead gen, ops, self-development).

- `src/runtime/specialists.ts` contains one config object (`ALFRED_AGENT`): system prompt + tool allowlist + model + max iterations.
- All tools are Zod-defined, auto-discovered from `src/tools/definitions/*.tool.ts`, and filtered by the allowlist at runtime.
- Deterministic code is limited to guardrails: budget, time, safety, cancellation, persistence. The model decides intent, sequencing, and completion.

## 3. Sessions – Isolated & Parallel
- Full multi-session support: long-running (Product A), short-term (Outreach campaign), or one-off.  
- Each session has its own isolated memory namespace (separate Daily notes + RAG index).  
- SOUL.md personality is shared across all sessions.  
- Unlimited parallel sessions (hardware permitting).  
- Switch/start sessions via web UI, Telegram, or command.

### 3.1 Session Context Layers
Session continuity should be layered instead of forcing all history into every prompt.

1. **Live session context**
   - Recent turns remain raw and directly available to Alfred.
   - This is what should handle normal follow-ups like "paste them" or "do that again".
2. **Session working memory**
   - A compact structured summary of the active thread, recent outputs, artifacts, and unresolved items.
   - Used to support continuity without replaying the full transcript every turn.
3. **Durable logs and memory**
   - Full run logs and daily transcripts remain available for audit, debug, and later retrieval.
   - These are not injected wholesale into the active loop unless explicitly needed.

## 4. Broad & Varied Use Cases
1. **Build Email List** – “Generate 100 fintech leads in India → verified emails → CSV (I’ll send manually).”  
2. **Think of Blog & Post** – “Research + write full 2,500-word blog on TS agents, generate images, schedule to site + LinkedIn.”  
3. **Build Itself / Better Itself** – “Review logs, study Peter Steinberger’s latest repo, implement better local tool, open PR and update SOUL.md.”

## 5. Tool Registry

All tools are Zod-defined, auto-discovered from `src/tools/definitions/*.tool.ts`, and filtered by the allowlist in `src/runtime/specialists.ts`.

**Search & Web**
- `search` — web search via SearXNG (primary) with Brave/BrightData fallback
- `web_fetch` — fetch and render pages (Playwright or HTTP)
- `search_status` — live provider health check
- `recover_search` — trigger SearXNG recovery

**Memory**
- `rag_memory_query` — semantic search over `workspace/alfred/knowledge/` via QMD
- `log_session` — write a session summary to the knowledge base and re-index

**Lead Generation**
- `lead_generation` — full pipeline: discover → extract → score → persist to CSV
- `lead_extractor` — deep extraction from a single company URL

**File & Shell**
- `file_read`, `file_write`, `file_edit`, `file_list` — workspace file operations
- `shell_exec` — safe shell commands (`.env` read blocked)
- `code_discover` — BFS code search with regex/semantic modes

**Writing**
- `writer_agent` — long-form draft generation from fetched context

**Process**
- `process_list`, `process_stop` — local process management

**Diagnostics**
- `run_diagnostics` — telemetry and failure analysis for a run

**Planned / Not Yet Shipped**
- `send_emails` — outreach via Resend/SendGrid (approval required)
- `pinchtab_fetch`, `pinchtab_search` — JS-rendered scraping via Pinchtab (optional)

## 6. Folder Structure

Three-layer dependency hierarchy. Lower layers never import from higher layers; enforced by `pnpm run lint:layers`.

```
alfred/
├── src/
│   ├── types.ts              # Foundation — zero internal deps
│   ├── utils/                # Foundation — pure utilities (retry, redact, fs)
│   ├── config/               # Foundation — env schema + appConfig
│   ├── provider/             # Core — LLM adapters (openai, anthropic, gemini, ollama)
│   ├── tools/                # Core — tool types, registry, definitions/, lead/, csv/, search/
│   ├── memory/               # Core — session store, daily notes, RAG extractor
│   ├── runs/                 # Core — run store + event log
│   ├── workers/              # Core — in-memory queue
│   ├── runtime/              # Core — agent loop, specialists, approval, thread/turn runtime
│   ├── runner/               # Application — ChatService (entry point for a turn)
│   ├── channels/             # Application — Telegram adapter + ChannelAdapter interface
│   ├── gateway/              # Application — Hono HTTP server + API routes
│   ├── prompts/              # Application — system prompt fragments
│   └── evals/                # Application — eval metrics
├── webui/                    # React + Vite + Tailwind (chat + session switcher)
├── SOUL.md                   # Alfred's identity document (loaded by reference in system prompt)
├── AGENTS.md                 # Codebase conventions + Alfred self-development guide
├── workspace/                # Runtime workspace (sessions, artifacts, knowledge)
│   └── alfred/
│       ├── sessions/
│       └── knowledge/
│           ├── Daily/YYYY/MM/DD.md
│           ├── Research/
│           ├── Leads/
│           └── Decisions/
├── .env
└── package.json
```


## 7. Personality – SOUL.md (OpenClaw style)
Loaded at runtime into every ReAct loop. You edit once and Alfred instantly becomes more “you”.  
Example tone:  
“You are Alfred — Nikhil’s loyal, no-nonsense, badass butler. Think step-by-step. Be precise. Protect the mission. Never overstep. Always offer options when asking for approval.”

## 8. Memory – Pure Markdown + QMD (Tiago Forte style)
- **Source of truth**: Plain `.md` files only (no heavy DB).  
- Daily raw transcripts: `knowledge/Daily/2026/03/03.md`  
- Nightly job: creates short summaries with citations back to raw files.  
- Retrieval: **QMD** (lightweight keyword + semantic search) — fast, human-readable, git-friendly.  https://github.com/tobi/qmd <-- src for QMD
- Per-session isolation.  
- You can open the entire knowledge base in Obsidian or any editor.

### 8.1 Memory Strategy
Alfred should not rely on retrieval for recent conversation that still fits comfortably in the model context window.

- **Up to the comfortable context budget**:
  - Keep recent session turns live in prompt context.
  - Do not replace fresh conversational continuity with summaries prematurely.
- **When context pressure appears**:
  - Compact older session history into structured working memory plus a concise narrative summary.
  - Preserve key decisions, goals, artifacts, blockers, and unresolved threads.
- **End-of-day / background compaction**:
  - Full daily logs remain persisted.
  - A background compaction pass can distill them into durable memory for later QMD retrieval.
- **Design rule**:
  - raw recent context -> structured session memory -> retrievable long-term memory
  - not "summarize everything immediately"

## 9. Authentication & Model Support
- **Primary**: Direct API keys (Grok-4 via @ai-sdk/xai, Gemini, Claude).  
- **Advanced**: OAuth login flow (OpenAI/Codex-style “login with your account” so the app can use your Codex quota without you pasting keys).  
- Model router picks the best model per task automatically.

## 10. Tech Stack
- TypeScript + pnpm  
- Gateway: Custom ReAct (Mastra/LangGraph.js optional later)  
- Queue: p-queue + worker_threads pool using in-memory pnpm package - (BullMQ + Redis when we move to scale - 4-6 weeks)  
- Browser: Playwright  
- Local execution: Node `child_process` + `shell_exec` tools  
- Validation: Zod  
- UI: React + Vite + Tailwind  
- Comms: Telegram/WhatsApp/Slack adapters  
- Deployment: One-command on RPi/VPS/DO droplet

## 11. Timelines & MVP
**Quickest realistic MVP** (basic email search + CSV so you can manually send): **IMMEDIATE**  

**MVP Scope (by end of the week)**  
- Gateway + ReAct + sessions  
- Tools: web_search, find_emails, write_csv, notify_user, basic shell/file tools  
- SOUL.md + simple UI/Telegram  
- Deliverable: “Alfred, find 50 leads and give me a CSV” → works today.

**4-Week Milestone**  
- Full local machine control + Playwright + nightly summaries  

**6-Month & 12-Month** Complete 2nd brain with multiple use cases

## 12. Risks & Guardrails
- All shell/system commands require explicit approval (configurable in SOUL.md).  
- Scraping = public sites only.  
- Everything auditable in plain logs + Markdown.
