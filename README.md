# Alfred v1

![Alfred Masthead](assets/alfred_masthead.jpg)

There is no Batman without Alfred. 

## Long-Term Vision

Alfred is intended to become a true personal second brain: a reliable agent that can reason, act, remember context over time, and execute across many workflows (research, outreach, writing, planning, operations, and more).

The target end-state is not a single-purpose bot, but an always-on execution layer that can run practical tasks end-to-end with transparent logs, controlled guardrails, and durable memory.

The intended interaction model is conversational first: Alfred should retain recent session context naturally, form a canonical task brief only when execution begins, and rely on memory compaction/retrieval only when the conversation outgrows the comfortable live context window.

To begin with, Alfred is a local-first AI agent for lead generation. 

## Why Lead Gen First

Lead generation is the initial focused wedge. It gives a measurable, high-value workflow where we can validate real-world outcomes quickly:

- lead quality
- email coverage
- cost per lead
- reliability under real run budgets

Once this workflow is consistently strong, Alfred expands outward into broader general-purpose second-brain capabilities.

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
