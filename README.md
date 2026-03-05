# Alfred v1

Alfred is a local-first AI agent for lead generation.  
Current focus: find USA SI/MSP companies, enrich them (including emails when available), and export usable CSV artifacts with full run timelines.

## What Alfred Does Today

- Runs a lead-only agent loop: `plan -> act -> observe -> replan`.
- Uses SearXNG as primary search (with health checks and recovery hooks).
- Browses pages with Playwright, extracts structured leads, dedupes, and quality-scores.
- Performs optional email enrichment from company sites.
- Persists runs, tool calls, timeline events, and exported debug bundles.
- Supports session management and run cancellation in the web UI.

## Current Status (March 2026)

- Foundation is in place and operational end-to-end for lead generation.
- Output quantity has improved significantly; quality tuning is still active.
- Search reliability and extraction accuracy are the main optimization areas now.
- Agent budget controls, failure telemetry, and stop-reason reporting are implemented.

## High-Level Plan

1. Improve lead quality and efficiency (better search yield, better extraction precision, tighter scoring).
2. Expand toolset (stronger enrichment, additional providers, then broader intent coverage).
3. Harden operations (observability, reliability, and production-safe guardrails).

## Quick Start

### 1) Prerequisites

- Node.js 20+
- `pnpm` (repo is fully on pnpm)
- Running SearXNG instance (recommended for primary search)

### 2) Install and configure

```bash
pnpm install
cp .env.example .env
```

Edit `.env` and set at least:

- `OPENAI_API_KEY`
- `PORT` (default `3000`, can be changed to `9001` or any free port)
- `SEARXNG_BASE_URL` and related SearXNG settings

### 3) Start Alfred gateway

```bash
pnpm run dev:gateway
```

Open:

- `http://localhost:<PORT>/ui`

### 4) Run a lead request

- Create/select a session in UI.
- Enter a request like `Find 20 MSP leads in USA with emails`.
- Watch progress in Run Timeline.
- Download/debug via run export if needed.

## Useful Commands

```bash
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:smoke
pnpm run test:security
pnpm run setup:browsers
```

## Key Paths

- Gateway/API: `src/gateway`
- Agent loop: `src/core`
- Lead pipeline: `src/tools/lead`
- Search manager: `src/tools/search`
- Web UI: `webui`
- Runtime artifacts: `workspace/alfred`
- Project docs: `docs/`

## Documentation

- `docs/spec.md` - product and architecture blueprint
- `docs/progress.md` - implementation status by phase
- `docs/changelog.md` - change history
- `docs/git_workflow.md` - branch and release process
