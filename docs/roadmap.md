# Alfred Roadmap

## Done

| Track | What shipped |
|-------|-------------|
| Architecture | Layered `src/` structure, ESLint zone enforcement, single-agent model |
| Multi-provider LLM | Anthropic, Gemini, OpenAI, Ollama — configured via `.env` |
| Channels | Telegram adapter with session isolation, allowlist auth, async UX |
| Security | Output scrubber, API key auth (auto-generated), instruction provenance model |
| Memory | QMD-backed RAG (`rag_memory_query`), `log_session` tool, context card injected at startup |
| Lead gen | Modular lead pipeline (`leadProfiles`, `leadScoring`, `leadPersistence`) |
| Web UI | Session switcher, live run progress, debug drawer, API key auth overlay |

## Next

- **`pnpm setup` onboarding script** — first-run CLI wizard: pick LLM provider, paste API key, personalize SOUL.md
- **Fix OpenAI-hardcoded tools** — `docQa` and `writerAgent` instantiate OpenAI directly; should use active provider from context
- **Lead-gen as standalone MCP server** — extract lead pipeline into a separate repo, expose as MCP tools usable by any agent (Claude Desktop, Cursor, etc.)
- **Open source packaging** — Dockerfile + docker-compose (Alfred + SearXNG sidecar), GitHub Actions CI

## Considering

- WhatsApp adapter (Twilio)
- Video clipper tool (thin wrapper around `videoclipper` CLI)
- Self-improvement: `git push` with approval gate so Alfred can open PRs on its own codebase
