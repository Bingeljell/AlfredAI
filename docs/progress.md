# Alfred MVP Progress

## Phase Map

- Phase 0: Bootstrap and governance
- Phase 1: Gateway + sessions + run lifecycle
- Phase 2: ReAct loop orchestration
- Phase 3: Search provider manager (SearXNG + Brave fallback)
- Phase 4: Lead extraction pipeline (Cheerio-first, Playwright-enrichment)
- Phase 5: Web UI + debug export
- Phase 6: Policy modes (dev trusted / prod balanced)
- Phase 7: Hardening and documentation

## Current Status

- **Phase 0**: Completed
  - Project scaffold created with TypeScript scripts and `.env.example`.
  - Test script wrappers now map to real `pnpm run test:*` commands.
- **Phase 1**: Completed
  - Hono gateway, session APIs, run persistence and JSONL timeline logging implemented.
- **Phase 2**: Completed
  - `runReActLoop(sessionId, message, options)` implemented and wired to `/v1/chat/turn`.
- **Phase 3**: Completed
  - SearXNG provider with healthcheck + auto-start command + Brave fallback implemented.
  - Search results capped at max 15 in manager-level enforcement.
- **Phase 4**: Completed
  - Cheerio-based first pass on top results implemented.
  - Optional Playwright enrichment pass implemented as dynamic/optional dependency path.
- **Phase 5**: Completed
  - Simple web UI added with sessions list/create, chat turn execution, run timeline, and debug export.
- **Phase 6**: Completed
  - `ALFRED_ENV=dev|prod` policy behavior wired through approval decision logic.
- **Phase 7**: In progress
  - Core tests added (unit/integration/smoke/security).
  - Lead quality iteration completed: multi-query search fan-out and list-page company extraction are now implemented with regression coverage.
  - Sub-ReAct lead pipeline migration completed: strict lead schema, `sub_react_step` timeline events, batched structured extraction, and persistent Playwright browser pool.
  - Playwright setup is now mandatory for the lead pipeline path with one-time browser bootstrap support.
  - Run timeline UX now renders `sub_react_step` phases in a readable stepwise view while retaining raw JSON for debugging.
  - Lead target-count intent parsing is now robust for natural prompts (`find me 20...`) and can use model-planned count when available.
  - Extraction step now emits per-batch failure diagnostics for schema/API/content failures to make zero-result runs debuggable.
  - OpenAI HTTP failure diagnostics now include structured metadata (error type/code/message + request and rate-limit headers) and are surfaced in sub-ReAct timeline payloads for query-planning and extraction troubleshooting.
  - Strict JSON-schema compatibility fixes are in place for query/extraction structured outputs (nullable required fields), and search-stage events now include per-query failure detail so `urlCount: 0` runs are diagnosable from timeline data.
  - Live progress visibility is now improved with periodic backend heartbeat events (`observe:heartbeat` every 10s) and UI polling that streams run-state/timeline updates while queued/running.
  - Deferred roadmap tracking moved to `docs/to_revisit.md` for browse-budget controls and LLM cap expansion after validation.
  - Test/build script wrappers were migrated from `npm` to `pnpm`, and `pnpm-lock.yaml` is now committed with `package-lock.json` removed.
  - Additional resiliency and production hardening tasks remain for later iterations.

## Remaining Follow-ups

- Add robust lead parsing quality heuristics and optional provider-based verification.
- Enable robots-aware scraping mode for production profile.
- Add structured retry/backoff metrics and deeper async supervision dashboards.
