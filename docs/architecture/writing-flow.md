# Alfred Writing Flow

This document describes the current research -> writing runtime pattern after the memory and core-behavior refactor work.

It is intentionally generic. The same loop shape should support articles, notes, comparison writeups, research packets, and later writing-oriented tools.

## Design rule

- `LLM owns semantics`
- `Runtime owns mechanics`

Meaning:

- the model decides what the task means, whether assumptions are acceptable, what evidence matters, and when synthesis is ready
- the runtime manages budgets, tool execution, persistence, retrieval, and recovery when the next mechanical step is already obvious

## Current writing path

1. User sends a plaintext request.
2. Alfred grounds the turn against:
   - current user message
   - recent conversation
   - session working memory
   - recoverable recent outputs/artifacts
3. Alfred builds an immutable turn contract from model interpretation.
4. Alfred decides whether to:
   - respond directly
   - call tools directly
   - delegate to `research_agent`
5. For writing/research-heavy work, Alfred typically delegates to the specialist loop.
6. Specialist loop builds and updates generic active-work state:
   - assumptions
   - candidate sets
   - evidence records
   - unresolved items
   - synthesis state
7. Retrieval tools run as needed:
   - `search`
   - `lead_search_shortlist`
   - `web_fetch`
   - other task-relevant tools
8. Specialist loop decides whether it is ready to assemble/synthesize from current evidence.
9. `writer_agent` only runs if `writerReadiness` says the write pass is mechanically viable.
10. Writer now follows a shape-aware path:
   - interpret the requested deliverable shape
   - draft directly in that final shape
   - semantically review whether the draft matches the requested deliverable
   - repair if the draft drifted into process commentary or missed key requirements
11. If writer succeeds with a meaningful draft, the output is persisted to a session artifact path when appropriate and registered in session memory as a recent output.
12. Alfred returns either:
   - a completed output
   - a reusable partial
   - metadata-only recovery state
   - or an honest failure summary

## Memory in writing runs

Writing runs now use the same memory model as the rest of Alfred:

- `live context`
  - recent turns for immediate follow-ups
- `working memory`
  - active objective
  - recent outputs
  - unresolved items
  - thread summary
- `durable retrieval`
  - recoverable outputs derived from persisted prior runs

Important consequences:

- Alfred can ground a follow-up against prior session outputs without relying only on the last few text turns.
- If a prior output has a stored artifact and is marked `body_available`, Alfred can load a bounded body preview for planning.
- Fresh standalone turns do not automatically inherit stale artifact obligations from previous runs.

## Writer readiness contract

Writer is no longer treated as an emergency “finalize whatever exists” sink.

Before invoking writer, the runtime now checks:

- evidence readiness
- synthesis readiness
- output contract readiness
- viable remaining time window

If those conditions are not met, Alfred should:

- continue retrieval or assembly if budget allows
- or return an honest partial state

The goal is to avoid burning the last budget window on doomed placeholder drafting.

Once invoked, writer should now behave more like a direct agentic assistant:

- infer the deliverable shape first
- write the final deliverable directly
- avoid process memos unless explicitly requested
- use semantic review to decide whether the draft is actually reusable

## Output availability states

Writing-related outputs now have explicit availability semantics:

- `body_available`
  - a reusable body exists and can be read/reused
- `metadata_only`
  - Alfred knows the work happened and has recoverable metadata/summary, but not a reusable body
- `missing`
  - no recoverable output body or metadata is available

These states are used in specialist stop/failure handling and session output records.

## Clarification policy

Clarification should be rare.

Current behavior target:

- Alfred asks only when ambiguity is genuinely blocking
- delegated research contracts usually default to `clarificationAllowed=false` once Alfred has already accepted reasonable defaults
- planner must explicitly mark clarification as `responseKind=clarification`

Alfred should prefer:

- proceeding with explicit assumptions
- recording those assumptions in runtime state
- surfacing them in the final answer if needed

## Revision vs retrieval

The runtime now tries to distinguish:

- missing evidence
- completion gaps

That means Alfred should increasingly do this:

- if evidence is already strong, assemble/revise from current material
- if evidence is weak or missing, retrieve/fetch more before writing

This is not fully end-state yet, but it is the intended direction and is partially implemented in the specialist loop.

## Diagnostics and telemetry

Writing runs should be inspectable from run telemetry, not inferred from vague assistant text.

Useful current telemetry includes:

- specialist phase transitions
- active-work synthesis state
- writer readiness
- writer intent / draft / review / repair stages
- output availability
- guard-trigger events
- planner timeout/failure events
- artifact persistence

This is now the main debugging surface when writing runs fail.
