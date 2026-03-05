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
  - Live progress visibility is now improved with periodic backend heartbeat events (`observe:heartbeat` every 30s) and UI polling that streams run-state/timeline updates while queued/running.
  - Lead quality gate now applies employee-size-aware soft matching (in-range/near/unknown/out-of-range), includes conditional relax mode for high-deficit size-filtered runs, and exports size/selection metadata in CSV and run telemetry for clearer evaluation.
  - Size metadata extraction is now resilient: `sizeSource` was replaced with free-text `sizeEvidence` to avoid URL-format validation drops that previously zeroed entire extraction batches.
  - Extraction prompt quality is now upgraded with a schema-first system prompt that explicitly handles batched payloads, near-range confidence behavior, anti-hallucination constraints, and strict JSON output/repair expectations for higher extraction success.
  - Pass-2 agentic foundation started: tool registry is now folder-based auto-discovery with Zod input contracts, enabling model-directed tool invocation over `lead_pipeline`, `search`, and `write_csv`.
  - Lead-generation now runs through an outer agentic loop with iterative planning, action execution (single/parallel tools), observation history, replan triggers, and explicit stop-reason events (`target_met`, `budget_exhausted`, `diminishing_returns`, `tool_blocked`, `manual_guardrail`).
  - Agent-loop execution budgets are now configurable in `.env`, making iteration depth, parallelism, planner-call budget, observation window, and diminishing-return sensitivity tunable without code changes.
  - Planner structured-output reliability is fixed: tool inputs are now emitted as JSON strings (`inputJson`) to satisfy strict response-format schema validation, parsed before tool execution, and fallback sequencing now avoids repeated `write_csv` actions when planner calls fail.
  - Agentic recovery behavior is now enabled for search outages: Alfred can call `search_status` and `recover_search`, observe whether primary-provider restart succeeded, and replan from explicit search-failure telemetry (`searchFailureCount` and samples) instead of treating provider downtime as a static terminal condition.
  - Lead extraction/output now includes optional `email` as a first-class field across structured extraction, normalized candidate mapping, and CSV export.
  - User-initiated run cancellation is now supported end-to-end: backend cancel API, persisted cancel requests, cooperative stop checks through lead loops, partial-result persistence, and a UI `Cancel Run` action.
  - Lead-quality hotfixes now reduce false dedupe collapse (company-identity keying instead of `sourceUrl` domain fallback), and browse-stage diagnostics now include per-URL failure telemetry plus a Playwright navigation fallback path to improve scrape coverage on difficult pages.
  - Extraction prompt quality is now further tightened for employee-size normalization with explicit numeric parsing rules, conservative null behavior, and anti-aggregator naming constraints to improve size-aware lead scoring outcomes.
  - `.env.example` now includes a usable default `SEARXNG_START_CMD` so local SearXNG auto-recovery can be exercised without extra manual wiring.
  - Extraction contract now requires `employeeSizeText` with explicit `"unknown"` fallback and captures `emailEvidence`, improving structured completeness for size-aware gating and downstream outreach analysis.
  - Quality-gate scoring now treats `unknown` employee size as neutral and gives `near_range` a small positive boost, reducing unnecessary filtering pressure for close-fit leads while preserving stronger penalties for clearly out-of-range companies.
  - Agent loop now injects adaptive `lead_pipeline.minConfidence` defaults when absent (`0.70` first pass, `0.65` second pass, and `0.60` from third pass onward when deficit remains high) to improve recall without discarding early precision.
  - Planner-provided lead filters are now wired end-to-end (tool schema -> normalization -> sub-pipeline), so employee-size/country/industry/email-intent constraints are no longer silently discarded before query planning.
  - Lead pipeline now runs a dedicated `email_enrichment` browse pass on extracted company sites (`/`, `/contact`, `/contact-us`, `/about`) to fill missing `email`/`emailEvidence` and expose enrichment coverage/failure telemetry in run outputs.
  - Quality ranking now applies explicit email-aware scoring (email bonus + no-email penalty, stronger when email is requested), so outreach-ready leads are prioritized ahead of equally matched records missing contact data.
  - End-of-run assistant summaries are now deterministic and metric-based (no LLM narration), with explicit lead/email/failure/budget numbers to avoid optimistic wording that diverges from actual CSV/run telemetry.
  - Lead deduplication now keys by normalized company identity first (name + location, with common suffix normalization) before domain fallback, reducing duplicate rows caused by aggregator/profile URLs.
  - Planner/observe loop now has structured failure awareness (search/browse/extraction counts + LLM-budget exhaustion flag) and applies a deterministic guardrail to check `search_status` before re-running `lead_pipeline` after search-failure iterations.
  - Run budget handling is now deadline-aware end-to-end: the agent avoids launching deep lead passes when remaining time is too low, dynamically downscales crawl settings under tight budgets, and propagates deadline checks into browse/extract/enrichment so runs persist partial work and stop gracefully instead of overrunning.
  - Email enrichment is now explicitly budget-aware with dynamic URL caps and diminishing-return early-stop behavior, reducing wasted crawl time while preserving useful email-fill improvements under constrained run budgets.
  - Run-level LLM usage accounting is now wired end-to-end (OpenAI response usage capture -> sub-pipeline/tool propagation -> run-state aggregation/events/final summary), and planner context now includes aggregate failure signals so replans can explicitly react to repeated tool/search/extraction failures.
  - Web UI timeline now surfaces planner thoughts, failure snippets, and incremental/token-total usage summaries directly in the readable timeline view (while preserving raw JSON), improving live-debug visibility during long runs.
  - Timeline display is now thought-first and less noisy: planner action payload expansions and trailing raw JSON dumps were removed from the default view to keep run monitoring focused on meaningful progress/failure lines.
  - Agent loop now maintains dynamic budget modes (`normal`, `conserve`, `emergency`) with anti-thrashing hysteresis, emits explicit budget-mode-change events, and gives the planner budget snapshot context so low-budget replans can prefer cheaper/high-yield actions.
  - Planner context now includes a capped `pastActionsSummary` memory block (recent tool choices + outcomes + key inputs) to improve replan quality while keeping context bounded and avoiding runaway prompt growth.
  - Deferred roadmap tracking moved to `docs/to_revisit.md` for browse-budget controls and LLM cap expansion after validation.
  - Test/build script wrappers were migrated from `npm` to `pnpm`, and `pnpm-lock.yaml` is now committed with `package-lock.json` removed.
  - Additional resiliency and production hardening tasks remain for later iterations.

## Remaining Follow-ups

- Add robust lead parsing quality heuristics and optional provider-based verification.
- Enable robots-aware scraping mode for production profile.
- Add structured retry/backoff metrics and deeper async supervision dashboards.
