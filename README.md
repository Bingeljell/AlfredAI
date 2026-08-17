# Alfred v1

![Alfred Masthead](assets/alfred_masthead.jpg)

There is no Batman without Alfred.

Alfred is a general-purpose AI agent — a co-conspirator, not a butler. He reasons, acts, remembers, and can extend his own capabilities. Talk to him via Telegram or the web UI. Give him a task; he figures out how to do it.

## What Alfred Does Today

- **General-purpose ReAct agent** — research, writing, lead generation, ops, file work, shell commands
- **Multi-provider LLM** — Gemini, Anthropic, OpenAI, Ollama, LM Studio, OpenRouter, and Codex subscription auth; configurable per deployment, with fast/smart model tiers
- **Headless browser control** — Alfred can drive a live browser session: navigate, click, type, fill forms, take screenshots
- **Remote agent orchestration** — monitors and dispatches tasks to coding agents (Claude, Codex, Pi, …) running in Herdr workspaces
- **Decoupled agent event webhook** — external agents/terminal wrappers push lifecycle events (`needs_approval`, `completed`, `failed`, `progress`) to Alfred, which routes them to Telegram
- **Telegram + Web UI** — converse from your phone or browser; live, edit-in-place progress updates as he works
- **Tiered persistent memory** — context card, per-day session logs, group chat logs, and QMD semantic recall across sessions
- **Self-extending** — Alfred can read his own codebase and write new tools mid-session
- **Credential-safe by default** — tool output and run telemetry are scrubbed of API keys and high-entropy secrets before they enter LLM context or logs
- **Tool ecosystem** — 30+ tools: search, web fetch, file ops, shell exec, process management, lead pipeline, writer, browser control, Herdr, memory (full catalog below)

## Important notes as of 15th August 2026

- **Personality** - Alfred's personality is meant to be a first principle's thinker, but not one who will overthink.
- **Ownership** - There's no onboarding right now, so you'll have to edit `SOUL.md` yourself and switch out the name, else Alfred's going to think he's working for me
- **Features** - Alfred is substantially built out (browser control, agent events, persistent memory, remote agent orchestration), but he's still evolving — new capabilities land regularly and behaviour may shift between releases.

## Tool Catalog

Alfred auto-discovers tools from `src/tools/definitions/` — each `*.tool.ts` file exports one tool. Everything below is enabled for the main agent.

| Tool | What it does |
|---|---|
| **Memory & knowledge** | |
| `rag_memory_query` | Semantic search of the long-term knowledge base (QMD) over past sessions, links, and decisions |
| `log_session` | Writes a summary of the current session to `knowledge/sessions/` for future recall |
| `save_link` | Persists a bookmark/summary/note to the knowledge base, updates `INDEX.md`, re-indexes QMD |
| `fetch_tweet` | Fetches a tweet via the Twitter API (`TWITTER_BEARER_TOKEN`) |
| **Search & web** | |
| `search` | Web search via SearXNG (primary), with Bright Data and Brave fallbacks |
| `web_fetch` | One-shot, read-only page extraction (title, text, tables, links) via headless Chromium |
| `search_status` / `recover_search` / `run_diagnostics` | Search health checks and recovery |
| **Browser control** (persistent session) | |
| `browser_navigate` | Open a URL; returns page text + numbered interactive elements |
| `browser_snapshot` | Re-read the current page state (elements re-numbered after each change) |
| `browser_click` | Click an element by snapshot index or text label |
| `browser_type` | Type into an input (optionally press Enter) |
| `browser_nav` | History (back/forward/reload) and key presses (Enter, Escape, Tab, …) |
| `browser_screenshot` | Save a PNG of the current page (or full-page) to the workspace |
| `browser_tabs` | List, open, activate, and close tabs |
| `browser_close` | Release the session browser when interaction is done |
| **Writing** | |
| `writer_agent` | Delegated drafting — blog posts, memos, emails, outlines, notes |
| **Ops & self-development** | |
| `code_discover` | Pattern-aware code search of the repo |
| `file_list` / `file_read` / `file_write` / `file_edit` | Workspace file operations (path-safe, project-rooted) |
| `shell_exec` | Shell commands (trusted mode only) |
| `process_list` / `process_stop` | Process inspection and termination |
| `doc_qa` | Answers questions from local docs/files with citations |
| `lead_extractor` / `lead_generation` | Lead pipeline (extract, score, persist) |
| `herdr_control` | Inspect/monitor/dispatch tasks to coding agents in Herdr workspaces (see `docs/features/herdr_control.md`) |

## Configuration

All configuration is via environment variables (see `.env.example`). Create your `.env` from the template:

```bash
cp .env.example .env
```

### LLM providers (set at least one)

| Variable | Default | Purpose |
|---|---|---|
| `ALFRED_LLM_PROVIDER` | `openai` | `openai` \| `anthropic` \| `gemini` \| `ollama` \| `lmstudio` \| `openrouter` \| `codex` |
| `OPENAI_API_KEY` | — | OpenAI |
| `ANTHROPIC_API_KEY` | — | Anthropic |
| `GEMINI_API_KEY` | — | Google Gemini (Google's naming convention) |
| `OPENROUTER_API_KEY` | — | OpenRouter (one key, many models) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api` | OpenRouter API root — the code appends `/v1/chat/completions`, so **do not** set the `/api/v1` form |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local Ollama (OpenAI-compatible) |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234` | Local LM Studio (OpenAI-compatible) |
| `ALFRED_CODEX_AUTH_FILE` | `~/.alfred/codex-auth.json` | Optional Alfred Codex credential path; use `pnpm codex:login`, not `OPENAI_API_KEY` |
| `ALFRED_MODEL_SMART` | `gpt-4o` | Main agent loop |
| `ALFRED_MODEL_FAST` | `gpt-4o-mini` | Cheap/fast calls (classification, session extraction) |

For **OpenRouter**, use model slugs exactly as OpenRouter lists them (e.g. `anthropic/claude-sonnet-4-20250514`, `openai/gpt-4o`). With Ollama/LM Studio use the model id the local server reports (e.g. `gemma-4-31b-it-qat`). For **Codex**, run `pnpm codex:login` (or `pnpm codex:login -- --device`) and set compatible model IDs in both `ALFRED_MODEL_SMART` and `ALFRED_MODEL_FAST`. `pnpm probe:model` helps discover locally served models.

### Server, auth & channels

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP gateway port |
| `ALFRED_ENV` | `dev` | `dev` = trusted policy (shell/process tools enabled); `prod` = balanced |
| `ALFRED_API_KEY` | auto-generated | Protects the web UI and all `/v1/*` routes; auto-generated on first start if unset |
| `ALFRED_AGENT_EVENT_TOKEN` | — | Shared secret for `POST /api/events/agent`; when unset the endpoint accepts loopback callers only |
| `TELEGRAM_BOT_TOKEN` | — | Enables the Telegram channel |
| `TELEGRAM_ALLOWED_USER_IDS` | — | Comma-separated numeric user IDs allowed to talk to the bot (fail-closed when empty) |
| `TELEGRAM_ALERT_CHAT_ID` | — | Chat ID for proactive agent-event pushes (approval gates, failures); leave blank to disable |

Autonomous wakeups and reminders are opt-in. Set `ALFRED_SCHEDULER_ENABLED=true` to enable the durable scheduler inside the gateway. It persists tasks and delivery ledgers under `workspace/alfred/scheduler/`, exposes `schedule_reminder`, `schedule_wake`, `schedule_watch`, `list_scheduled_tasks`, and `cancel_scheduled_task`, and provides `GET /v1/scheduler/status`. Scheduler-origin turns are bounded and cannot use mutating tools or schedule nested tasks.

### Search

| Variable | Default | Purpose |
|---|---|---|
| `SEARXNG_BASE_URL` / `SEARXNG_SEARCH_PATH` / `SEARXNG_HEALTH_PATH` | `http://127.0.0.1:8888` / `/search` / `/search?q=ping&format=json` | Primary search provider |
| `SEARXNG_START_CMD` | — | Command to auto-start SearXNG with Alfred (blank = run it yourself/Docker) |
| `SEARXNG_START_TIMEOUT_MS` / `SEARXNG_RETRY_INTERVAL_MS` / `SEARXNG_HEALTH_RETRIES` / `SEARXNG_HEALTH_RETRY_DELAY_MS` / `SEARXNG_HEALTH_GRACE_MS` | 15000 / 1000 / 2 / 250 / 15000 | Startup & health-check tuning |
| `BRIGHTDATA_SEARCH_API_KEY` + `BRIGHTDATA_SEARCH_*` | — | Bright Data search fallback (zone, engine, country, timeouts) |
| `BRAVE_SEARCH_API_KEY` | — | Brave search fallback |
| `ALFRED_SEARCH_MAX_RESULTS` | `15` | Max results per search |

### Browsing & scraping

| Variable | Default | Purpose |
|---|---|---|
| `ALFRED_ENABLE_PLAYWRIGHT` | `true` | Enables headless Chromium for `web_fetch` and browser control tools |
| `ALFRED_BROWSE_CONCURRENCY` | `3` | Parallel pages per `web_fetch` |
| `ALFRED_ENABLE_PINCHTAB` | `false` | Optional Pinchtab integration (`pinchtab_fetch`/`pinchtab_search`) |
| `PINCHTAB_BASE_URL` / `PINCHTAB_START_CMD` | `http://127.0.0.1:9867` / — | Pinchtab server config |

### Agent runtime

| Variable | Default | Purpose |
|---|---|---|
| `ALFRED_WORKSPACE_DIR` | `./workspace/alfred` | Where Alfred stores sessions, runs, knowledge, groups, browser screenshots, and agent-event logs |
| `ALFRED_CONCURRENCY` | `2` | Concurrent runs |
| `ALFRED_RUN_MAX_STEPS` | `6` | Steps per run |
| `ALFRED_AGENT_MAX_DURATION_MS` | `600000` | Hard deadline per run |
| `ALFRED_AGENT_MAX_TOOL_CALLS` | `18` | Tool-call budget per run |
| `ALFRED_AGENT_MAX_PARALLEL_TOOLS` | `3` | Parallel tool calls |
| `ALFRED_SCHEDULER_ENABLED` | `false` | Enable autonomous reminders, wake turns, and watches |
| `ALFRED_SCHEDULER_TICK_MAX_MS` | `15000` | Maximum scheduler recovery/tick interval |
| `ALFRED_SCHEDULER_MAX_CONCURRENCY` | `1` | Concurrent scheduler cycles (hard capped at 2) |
| `ALFRED_SCHEDULER_GLOBAL_WAKE_INTERVAL_MS` | `30000` | Minimum interval between autonomous LLM wake starts |
| `ALFRED_FAST_SCRAPE_COUNT` | `10` | Fast-scrape page budget |
| `TWITTER_BEARER_TOKEN` | — | Twitter API (for `fetch_tweet`) |

## Quick Start

### 1. Prerequisites

- Node.js 22+
- `pnpm`
- SearXNG instance (for search — self-host or use a public instance), or Bright Data / Brave keys as fallback
- At least one LLM API key (Anthropic, Google Gemini, OpenAI, or OpenRouter), or a Codex subscription login

### 2. Install

```bash
git clone https://github.com/Bingeljell/AlfredAI.git
cd AlfredAI
pnpm install          # postinstall also prepares Playwright Chromium
pnpm setup:browsers   # (optional) installs Chromium for browser control / web_fetch
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` — minimum required:

```
# LLM — set at least one
ALFRED_LLM_PROVIDER=gemini
GEMINI_API_KEY=
# or: ALFRED_LLM_PROVIDER=openrouter + OPENROUTER_API_KEY=

# Server
PORT=9001

# Search
SEARXNG_BASE_URL=http://localhost:8080

# Telegram (optional but recommended)
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
```

For OpenRouter specifically:

```
ALFRED_LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
ALFRED_MODEL_SMART=anthropic/claude-sonnet-4-20250514
ALFRED_MODEL_FAST=openai/gpt-4o-mini
```

### 4. Build and run

```bash
pnpm run build
pnpm start
```

Open `http://localhost:9001/ui` — create a session and start talking to Alfred.

For development (auto-rebuild on save):

```bash
pnpm run dev:gateway
```

### 5. Logs directory

Alfred writes logs to `logs/`. Create it if it doesn't exist:

```bash
mkdir -p logs
```

---

## Long-term memory (QMD)

Alfred's memory is tiered:

1. **Context card** — `workspace/alfred/knowledge/context-card.md`, injected at the top of every run.
2. **Session logs** — written via `log_session` to `workspace/alfred/knowledge/sessions/YYYY-MM-DD.md`.
3. **Saved knowledge** — links/summaries/notes via `save_link` under `workspace/alfred/knowledge/links/`.
4. **Group chat logs** — daily JSONL per channel group under `workspace/alfred/groups/`.
5. **Run logs** — raw run telemetry under `workspace/alfred/runs/`.

The `rag_memory_query` tool provides semantic recall over tiers 1–3 using **QMD**. Without QMD, Alfred still works fully — it just won't have long-term recall.

To enable:

```bash
npm install -g @tobilu/qmd

# Index Alfred's workspace knowledge
qmd collection add ./workspace/alfred/knowledge --name alfred-knowledge
qmd embed
```

Re-run `qmd embed` periodically (or after significant sessions) to keep the index fresh. `log_session` and `save_link` trigger re-indexing automatically when QMD is available.

---

## Browser control

Alfred keeps one headless Chromium session per chat, so he can work through a live page across multiple tool calls: navigate → snapshot (numbered interactive elements) → click/type → re-snapshot → screenshot.

Typical flow:

1. `browser_navigate` — open a URL, get text + elements `[0]`, `[1]`, `[2]`, …
2. `browser_type` — fill a search box by index (`{"index": 1, "value": "…", "pressEnter": true}`)
3. `browser_snapshot` — see the result before deciding the next step
4. `browser_click` — click a result or button (`{"index": 3}`)
5. `browser_screenshot` — capture a PNG (saved to `workspace/alfred/browser/screenshots/`)
6. `browser_close` — release the session when done

Prefer `browser_*` whenever the task needs interaction (forms, logins, site search, click-through); use `web_fetch` for one-shot read-only extraction.

---

## Agent event webhook

External agents and terminal wrappers (Herdr hooks, tmux/Zellij wrappers, standalone agent hooks) can push lifecycle events to Alfred over HTTP, so Alfred reacts instantly instead of polling. See `docs/architecture/agent_event_webhook_spec.md` for the full contract.

**Endpoint:** `POST /api/events/agent`

```bash
curl -X POST http://localhost:9001/api/events/agent \
  -H "Content-Type: application/json" \
  -H "X-Agent-Event-Token: $ALFRED_AGENT_EVENT_TOKEN" \
  -d '{
    "version": "1.0",
    "source": "herdr",
    "agentKind": "pi",
    "workspaceId": "w9",
    "paneId": "p2",
    "eventType": "needs_approval",
    "timestamp": 1755271200000,
    "payload": {
      "promptText": "Allow command: git push origin main [y/n]?",
      "suggestedAction": "confirm",
      "cwd": "/Users/yourname/projects/AlfredAI",
      "details": "git push origin main"
    }
  }'
```

**Event types**

| `eventType` | Alfred's action |
|---|---|
| `needs_approval` | Push an actionable Telegram alert with `/approve w9:p2` / `/reject w9:p2` hints |
| `completed` | Record; push to Telegram only when `payload.ping` is `true` |
| `failed` | Push an error alert (includes error + exit code) |
| `progress` | Record only (optional milestone) |

**Auth:** requests must present `X-Agent-Event-Token` matching `ALFRED_AGENT_EVENT_TOKEN`. When no token is configured, only loopback callers (127.0.0.1 / ::1) are accepted.

**Dispatch:** `needs_approval`/`failed`/pinged `completed` events are pushed to `TELEGRAM_ALERT_CHAT_ID` (console fallback if Telegram is not configured). Every event is appended to a JSONL job log under `workspace/alfred/agent-events/YYYY/MM/YYYY-MM-DD.jsonl`.

---

## Remote agent orchestration (Herdr)

`herdr_control` lets Alfred act as a remote command centre for coding agents (Claude, Codex, Pi, …) running in Herdr workspaces — listing workspaces/panes, capturing pane output, and dispatching prompts. Alfred talks to Herdr over its local JSON socket; no raw tmux parsing. See `docs/features/herdr_control.md`.

---

## Security: output scrubbing

Before tool results enter LLM context (and before run telemetry/debug exports are persisted), Alfred runs them through a shared redaction pipeline (`src/utils/redact.ts`) that:

1. Drops values whose JSON key names a secret (`api_key`, `token`, `password`, …)
2. Drops strings that are whole known API keys (Anthropic/OpenAI/GitHub/Slack/AWS prefixes, JWTs)
3. Drops high-entropy strings that look like keys, with safe-pattern exemptions
4. Masks known key patterns embedded inline in prose or log lines

This unifies the former redact/scrubber pair into one implementation so LLM context, run telemetry, and debug exports are scrubbed identically. See `docs/architecture/security-upgrade-2026-07.md`.

---

## Run as a background service (macOS launchctl)

To have Alfred start automatically on login and stay running, set it up as a LaunchAgent.

### 1. Find your paths

```bash
which pnpm          # e.g. /Users/yourname/.nvm/versions/node/v22.x.x/bin/pnpm
pwd                 # run from the repo root — e.g. /Users/yourname/Projects/AlfredAI
echo $HOME          # e.g. /Users/yourname
```

### 2. Create the plist

Copy the template and fill in your paths:

```bash
cp scripts/com.alfred.plist.template ~/Library/LaunchAgents/com.alfred.plist
```

Edit `~/Library/LaunchAgents/com.alfred.plist` and replace the four placeholders:

| Placeholder | Replace with |
|---|---|
| `PNPM_PATH` | output of `which pnpm` |
| `PROJECT_DIR` | absolute path to repo root |
| `HOME_DIR` | your home directory (`$HOME`) |
| `NODE_BIN_DIR` | the `bin/` directory containing pnpm (parent of `PNPM_PATH`) |

Example for a user `yourname` with nvm node v22:

```xml
<string>/Users/yourname/.nvm/versions/node/v22.19.0/bin/pnpm</string>
...
<string>/Users/yourname/Projects/AlfredAI</string>
...
<string>/Users/yourname</string>
<string>/Users/yourname/.nvm/versions/node/v22.19.0/bin:/usr/local/bin:/usr/bin:/bin</string>
```

### 3. Load the service

```bash
launchctl load ~/Library/LaunchAgents/com.alfred.plist
```

Alfred will start immediately and restart automatically if it crashes.

### 4. Manage Alfred

```bash
# Stop
launchctl stop com.alfred

# Start
launchctl start com.alfred

# Restart (after code changes or config updates)
launchctl stop com.alfred && launchctl start com.alfred

# Unload completely (disable autostart)
launchctl unload ~/Library/LaunchAgents/com.alfred.plist

# Watch logs
tail -f logs/alfred.log
tail -f logs/alfred-error.log
```

---

## Key Paths

```
src/runtime/        — agent loop, system prompt, specialists config
src/agentEvents/    — agent event webhook (schema, auth, dispatcher, Telegram notifier, event store)
src/tools/          — all tool definitions (drop a *.tool.ts here to add a tool)
src/tools/browser/  — persistent browser control engine (session registry, DOM helpers)
src/tools/search/   — search providers (SearXNG, Bright Data, Brave)
src/provider/       — LLM adapters (Anthropic, Gemini, OpenAI, Ollama, LM Studio, OpenRouter, Codex)
src/channels/       — Telegram + channel adapter interface
src/runner/         — ChatService, conversation window management
src/gateway/        — HTTP server, Web UI API, agent event endpoint
src/memory/         — session memory, group chat store, RAG
src/utils/          — redaction (credential scrubbing), path safety
webui/              — Web UI
SOUL.md             — Alfred's identity and values
AGENTS.md           — codebase conventions (also injected into Alfred's system prompt)
docs/               — architecture docs, spec, changelog, feature specs
```

## Useful Commands

```bash
pnpm run build          # compile TypeScript
pnpm start              # run compiled build
pnpm run dev:gateway    # run with auto-rebuild
pnpm setup:browsers     # install Playwright Chromium (for browser control / web_fetch)
pnpm probe:model        # probe a local LLM server for its model list
pnpm run test           # unit + integration + security
pnpm run test:unit
pnpm run test:integration
pnpm run test:smoke
pnpm run test:security
pnpm run lint:layers    # eslint + architectural boundary checks
```

## Documentation

- `docs/spec.md` — architecture and product blueprint
- `docs/roadmap.md` — what's done, what's next
- `docs/changelog.md` — change history
- `docs/tool_contract.md` — the single-agent tool contract
- `docs/features/herdr_control.md` — Herdr remote orchestration feature spec
- `docs/architecture/` — deep dives: security model, agent event webhook spec, Alfred's identity, turn lifecycle, refactor history
