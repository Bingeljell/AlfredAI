# Core Behaviour Refactor

## The Principle

> LLM owns semantics. Runtime owns mechanics.

Alfred interprets intent, continuity, and completion using model reasoning.
Deterministic code persists memory, validates schemas, enforces safety, and executes tools.

---

## Why the Old Architecture Failed

### The Planner-Per-Iteration Pattern

Before the March 2026 rewrite, Alfred's execution loop looked like this:

```
User message
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  runAlfredOrchestratorLoop (~3,200 lines)            │
│                                                      │
│  for each iteration (max 6):                        │
│    │                                                 │
│    ├─ 1. TurnInterpretation LLM call                 │
│    │     ↳ derives task type, contract, constraints  │
│    │                                                 │
│    ├─ 2. Planner LLM call                            │
│    │     ↳ "what is the single next action?"         │
│    │     ↳ serializes all state to JSON for context  │
│    │                                                 │
│    ├─ 3. Guard layer (mechanical + semantic mixed)   │
│    │     ↳ buildDirectExecutionOverrideForDelegation │
│    │     ↳ buildAlfredMechanicalRecoveryHint         │
│    │     ↳ buildSearchStalledOverride                │
│    │     ↳ ... multiple competing guards             │
│    │                                                 │
│    └─ 4. Execute one tool, serialize output to JSON  │
│                                                      │
└─────────────────────────────────────────────────────┘
```

**What went wrong in practice:**

```
Iteration 1: Planner → "search for family games 2024"
Iteration 2: Planner → "search for multiplayer games 2025"   ← should have fetched
Iteration 3: Planner → "search for family multiplayer 2026"  ← still searching
[buildSearchStalledOverride fires]
Iteration 4: OVERRIDE → web_fetch (URLs from iter 1-3)
Iteration 5: Planner → "search for more games"              ← regressed back!
[buildSearchStalledOverride fires again, same URLs]
Iteration 6: OVERRIDE → web_fetch (same URLs, redundant)
→ Loop exhausted. No synthesis. No answer.
```

**Root causes:**

1. **State serialization loss** — at each iteration, all context is compressed to JSON and handed to a fresh planner call. The model loses continuity of what it just saw.

2. **Competing semantic layers** — TurnInterpretation, the planner directive, mechanical hints, and guard overrides all tried to control the same decision (search vs fetch vs respond). They conflicted.

3. **One tool per iteration** — the model could not naturally chain search → fetch → respond. Every step required burning an iteration and a planner LLM call.

4. **Tight maxIterations** — with 6 iterations and a bad sequence, synthesis never had a slot.

---

## The New Architecture

### Overview

```
User message
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  runOrchestrator                                     │
│                                                      │
│  1. One classification LLM call (gpt-4o-mini)        │
│     ↳ research | writing | lead | ops               │
│                                                      │
│  2. Select SpecialistConfig                          │
│     ↳ system prompt + tool allowlist + model        │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│  runAgentLoop (native tool-calling)                  │
│                                                      │
│  Messages = [ system, user ]                        │
│                                                      │
│  loop:                                              │
│    ├─ LLM call (full conversation in context)        │
│    │                                                 │
│    ├─ finish_reason == "stop"?                       │
│    │   └─ return assistantText ✓                    │
│    │                                                 │
│    └─ finish_reason == "tool_calls"?                 │
│        ├─ execute tool_1 → append result to messages │
│        ├─ execute tool_2 → append result to messages │
│        └─ continue loop (model sees all results)     │
│                                                      │
└─────────────────────────────────────────────────────┘
```

**What the same task looks like now:**

```
Messages: [system, user: "list 10 family games 2024-2026"]

LLM call 1:
  → tool_calls: [search("family multiplayer games 2024 2026")]

Execute search → append result to messages

LLM call 2:
  → tool_calls: [web_fetch(urls=[...])]   ← model decides to fetch, not search again

Execute web_fetch → append page content to messages

LLM call 3:
  → finish_reason: "stop"
  → content: "Here are 10 family-friendly multiplayer games..."  ✓
```

No state serialization. No competing guards. The model sees its own prior tool results in full context and decides naturally when it has enough to answer.

---

## File Map

> Note: paths below reflect the March 2026 restructure. `src/core/` → `src/runtime/`, `src/services/llm/` → `src/provider/`, `src/services/openAiClient.ts` → `src/provider/openai-http.ts`. `orchestrator.ts` was subsequently deleted (collapsed into `runReActLoop.ts` directly).

### New Files (March 17 rewrite)

| File | Role |
|---|---|
| `src/runtime/agentLoop.ts` | Native tool-calling loop |
| `src/runtime/specialists.ts` | Alfred agent config (system prompt + tool allowlist + model) |

### Modified Files (March 17 rewrite)

| File | Change |
|---|---|
| `src/provider/openai-http.ts` | Added `runOpenAiToolCallWithDiagnostics` — native tool-call format |
| `src/runtime/runReActLoop.ts` | Entry point — calls agent loop directly (orchestrator layer removed) |

### Deleted Files

| File | Why deleted |
|---|---|
| `src/core/runAlfredOrchestratorLoop.ts` | Replaced by orchestrator + agentLoop |
| `src/core/runLeadAgenticLoop.ts` | Lead specialist now runs via agentLoop |
| `src/core/runSpecialistToolLoop.ts` | Specialist routing now via specialists.ts + agentLoop |
| `src/core/runAgentLoop.ts` | Was a thin wrapper over the skills registry |
| `src/agent/skills/leadAgentSkill.ts` | Skills registry replaced by SpecialistConfig |
| `src/agent/skills/opsAgentSkill.ts` | Same |
| `src/agent/skills/registry.ts` | Same |
| `src/agent/skills/types.ts` | Same |

---

## Single Agent

Alfred is one `SpecialistConfig` object in `src/runtime/specialists.ts`: one system prompt, one tool allowlist, one model, one max iteration count. There is no classifier and no routing to sub-agents.

The unified system prompt contains:
- Alfred identity (who he is, values, how to behave)
- Pipeline sections for each task type (LEAD GENERATION, RESEARCH, WRITING, OPERATIONS)
- SELF-AWARENESS section (how to read and extend his own codebase)
- General rules

The model self-routes by reading the message and following whichever pipeline section applies.

---

## How Tool Context State Still Works

All existing tool definitions (`search.tool.ts`, `webFetch.tool.ts`, `writerAgent.tool.ts`, etc.) are unchanged. They still receive a `LeadAgentToolContext` with mutable state callbacks (`setFetchedPages`, `setResearchSourceCards`, `addLeads`, etc.).

The difference: this state is now a side-channel for tools that need it (e.g. `writer_agent` reads source cards set by a prior `web_fetch` call). The primary information channel is the native conversation — tool results come back as `role: "tool"` messages and the model reads them directly.

```
web_fetch called
  → sets context.fetchedPages (for writer_agent)
  → returns JSON summary to conversation (for model reasoning)

writer_agent called
  → reads context.researchSourceCards for citations
  → generates draft
  → returns draft content + outputPath to conversation
```

---

## Routing

There is no classifier. Alfred receives the user message directly in the single-agent loop. The unified system prompt contains pipeline sections for each task type. The model reads the message and follows whichever pipeline applies — no regex, no LLM classification call, no routing layer.

---

## What This Fixes

| Old problem | New behaviour |
|---|---|
| Planner could call search 6x without fetching | Model sees its own prior search results; the research specialist system prompt enforces max 2 searches before fetch |
| Guards competed with planner, causing hijacking bugs | Guards are gone. Rules live in the system prompt. |
| `maxIterations=6` was the only safety net | Model stops itself via `finish_reason: stop`; maxIterations is a hard ceiling only |
| State lost between iterations via JSON serialization | Full conversation history is in context — nothing is discarded |
| Two LLM calls per iteration (interpretation + planner) | One LLM call per iteration, no separate planner |

---

## What's Still Pending

- **Heartbeat events** — the old loop emitted `heartbeat` events that drove the UI elapsed-time ticker. The new loop does not. A lightweight interval-based emitter should be added to `agentLoop.ts`.
- **Model thought events** — the UI's thinking panel expected `alfred_plan_created` events with the planner's reasoning text. The new loop doesn't emit these. Should emit the assistant's text content (when present alongside tool calls) as a `thought` phase event.
- **Automated tests for new core files** — `agentLoop.ts`, `orchestrator.ts`, and `specialists.ts` have no unit tests yet. Deferred until post-validation of the live pipeline. Tracked in `docs/to_revisit.md`.

---

## Design Principle (Restated)

The refactor is the implementation of the principle stated at the top.

The old loop had deterministic code doing semantic work: deciding what constitutes "enough searching," when to transition phases, what counts as a completed synthesis. That's the LLM's job.

The new loop has deterministic code doing mechanical work: executing tools, appending results to the conversation, enforcing hard limits (timeout, max iterations, cancellation). The model decides everything else.
