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

## 3. Sessions – Isolated & Parallel
- Full multi-session support: long-running (Product A), short-term (Outreach campaign), or one-off.  
- Each session has its own isolated memory namespace (separate Daily notes + RAG index).  
- SOUL.md personality is shared across all sessions.  
- Unlimited parallel sessions (hardware permitting).  
- Switch/start sessions via web UI, Telegram, or command.

## 4. Broad & Varied Use Cases
1. **Build Email List** – “Generate 100 fintech leads in India → verified emails → CSV (I’ll send manually).”  
2. **Think of Blog & Post** – “Research + write full 2,500-word blog on TS agents, generate images, schedule to site + LinkedIn.”  
3. **Build Itself / Better Itself** – “Review logs, study Peter Steinberger’s latest repo, implement better local tool, open PR and update SOUL.md.”

## 5. Full Tool Registry
All tools are Zod-defined, auto-discovered, and tagged (inline/queued, requiresApproval).

**Research & Lead-Gen**  
- `web_search`, `browse_and_summarize`  
- `find_companies`, `find_emails` / `bulk_find_emails` (Hunter, Apollo, Skrapp APIs)  
- `scrape_public_page` (Playwright – public sites only)  
- `score_leads`, `summarize_leads`

**Data & Output**  
- `read/write/append_csv`, `file_read`, `file_write`, `file_append`

**Outreach**  
- `send_emails` (Resend/SendGrid – approval required)

**Local Machine Control** (runs on your RPi/VPS/laptop)  
- `process_list`, `process_kill`  
- `shell_exec` (safe, approval-gated)  
- `system_command` (start/stop services, e.g. “searXNG is down → shall I start it?”)  
- `docker_control`, `service_start/stop/restart`

**Coding & Self-Improvement**  
- `code_interpreter` (sandboxed)  
- `github_tools` (clone, analyze, create PR)  
- `analyze_github_repo` + `install_oss_tool`

**Memory & Comms**  
- `rag_memory_query` (QMD over Markdown)  
- `daily_note_append`  
- `notify_user` (Telegram, WhatsApp, Slack)  
- `calendar_search/book`

## 6. Future-Proof Folder Structure
alfred/
├── src/
│   ├── gateway/              # ReAct loops + session manager + model router
│   ├── workers/              # BullMQ (browser, shell, system, email, etc.)
│   ├── memory/               # QMD + nightly distillation
│   ├── tools/                # *.tool.ts (Zod)
│   ├── skills/               # Higher-level workflows
│   └── channels/             # Telegram, WhatsApp, Slack
├── webui/                    # React + Vite + Tailwind (chat + session switcher)
├── workspace/                # Shared
│   ├── SOUL.md               # Personality (loaded every loop)
│   ├── USER.md
│   └── AGENTS.md
├── knowledge/                # PARA + per-session
│   ├── Daily/YYYY/MM/DD.md
│   ├── Summaries/
│   ├── Projects/
│   ├── Areas/
│   └── Resources/
├── sessions/                 # Per-session overrides
├── logs/
├── .env
├── pnpm-workspace.yaml
└── package.json


## 7. Personality – SOUL.md (OpenClaw style)
Loaded at runtime into every ReAct loop. You edit once and Alfred instantly becomes more “you”.  
Example tone:  
“You are Alfred — Nikhil’s loyal, no-nonsense, badass butler. Think step-by-step. Be precise. Protect the mission. Never overstep. Always offer options when asking for approval.”

## 8. Memory – Pure Markdown + QMD (Tiago Forte style)
- **Source of truth**: Plain `.md` files only (no heavy DB).  
- Daily raw transcripts: `knowledge/Daily/2026/03/03.md`  
- Nightly job: creates short summaries with citations back to raw files.  
- Retrieval: **QMD** (lightweight keyword + semantic search) — fast, human-readable, git-friendly.  
- Per-session isolation.  
- You can open the entire knowledge base in Obsidian or any editor.

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