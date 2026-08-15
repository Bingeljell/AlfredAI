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

- **Security upgrade (July 2026)** — prioritized hardening from the read-only audit; see [`architecture/security-upgrade-2026-07.md`](architecture/security-upgrade-2026-07.md). Phase 0 (mechanical fixes) first, then the Unix-user containment floor, then provenance-based tool downgrade.
- **`pnpm setup` onboarding script** — first-run CLI wizard: pick LLM provider, paste API key, personalize SOUL.md
- **Fix OpenAI-hardcoded tools** — `docQa` and `writerAgent` instantiate OpenAI directly; should use active provider from context
- **Lead-gen as standalone MCP server** — extract lead pipeline into a separate repo, expose as MCP tools usable by any agent (Claude Desktop, Cursor, etc.)
- **Open source packaging** — Dockerfile + docker-compose (Alfred + SearXNG sidecar), GitHub Actions CI

## Deferred

- **Test gate** (deferred from the July 2026 security pass) — an aggregate `pnpm test` script now exists; still to do: GitHub Actions CI running `build` + `lint:layers` + `test` on push/PR, an optional local pre-push hook, and tightening AGENTS.md's Testing Workflow to require updating/adding tests in the same commit as any behavior change. Prompted by two unit tests that sat red unnoticed after refactors.

## Considering

- WhatsApp adapter (Twilio)
- Video clipper tool (thin wrapper around `videoclipper` CLI)
- Self-improvement: `git push` with approval gate so Alfred can open PRs on its own codebase
