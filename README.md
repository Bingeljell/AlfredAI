# Alfred v1

![Alfred Masthead](assets/alfred_masthead.jpg)

There is no Batman without Alfred.

Alfred is a general-purpose AI agent — a co-conspirator, not a butler. He reasons, acts, remembers, and can extend his own capabilities. Talk to him via Telegram or the web UI. Give him a task; he figures out how to do it.

## What Alfred Does Today

- **General-purpose ReAct agent** — research, writing, lead generation, ops, file work, shell commands
- **Multi-provider LLM** — Gemini, Anthropic, OpenAI; configurable per deployment
- **Telegram + Web UI** — converse from your phone or browser; live progress updates as he works
- **Persistent memory** — session context, conversation window, workspace artifacts
- **Self-extending** — Alfred can read his own codebase and write new tools mid-session
- **Tool ecosystem** — search (SearXNG), web fetch, file read/write/edit, shell exec, lead extraction, writer agent, RAG memory

## Important notes as of 25th March 2026
- **Personality** - Alfred's personality is meant to be a first principle's thinker, but not one who will overthink.
- **Ownership** - There's no onboarding right now, so you'll have to edit `SOUL.md` yourself and switch out the name, else Alfred's going to think he's working for me
- **Features** - Alfred is still very much in development - while he can do a lot of stuff and you can actually build him out the way you want, using him now is likely to be buggy. It's still worth it.
## Quick Start

### 1. Prerequisites

- Node.js 22+
- `pnpm`
- SearXNG instance (for search — self-host or use a public instance)
- At least one LLM API key (Anthropic, Google Gemini, or OpenAI)

### 2. Install

```bash
git clone https://github.com/Bingeljell/AlfredAI.git
cd AlfredAI
pnpm install
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` — minimum required:

```
# LLM — set at least one
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENAI_API_KEY=

# Server
PORT=9001

# Search
SEARXNG_BASE_URL=http://localhost:8080

# Telegram (optional but recommended)
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=
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

## Optional: RAG long-term memory

Alfred's `rag_memory_query` tool enables persistent semantic memory across sessions. Without it, Alfred still works fully — it just won't have long-term recall.

To enable:

```bash
npm install -g @tobilu/qmd

# Index Alfred's workspace knowledge
qmd collection add ./workspace/alfred/knowledge --name alfred-knowledge
qmd embed
```

Re-run `qmd embed` periodically (or after significant sessions) to keep the index fresh.

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
src/tools/          — all tool definitions (drop a *.tool.ts here to add a tool)
src/provider/       — LLM adapters (Anthropic, Gemini, OpenAI, Ollama)
src/channels/       — Telegram + channel adapter interface
src/runner/         — ChatService, conversation window management
src/gateway/        — HTTP server, Web UI API
src/memory/         — session memory, RAG, conversation store
webui/              — Web UI
SOUL.md             — Alfred's identity and values
AGENTS.md           — codebase conventions (also injected into Alfred's system prompt)
docs/               — architecture docs, spec, changelog
```

## Useful Commands

```bash
pnpm run build          # compile TypeScript
pnpm start              # run compiled build
pnpm run dev:gateway    # run with auto-rebuild
pnpm run test:unit
pnpm run test:integration
pnpm run test:smoke
```

## Documentation

- `docs/spec.md` — architecture and product blueprint
- `docs/roadmap.md` — what's done, what's next
- `docs/changelog.md` — change history
- `docs/architecture/` — deep dives: security model, Alfred's identity, turn lifecycle, refactor history
