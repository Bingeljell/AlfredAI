# Core Behaviour Refactor

## Goal

Make Alfred behave more like a general-purpose second brain and less like a prompt-shaped workflow engine.

Design rule:

- `LLM owns semantics`
- `Runtime owns mechanics`

That means:

- Alfred interprets user intent, continuity, assumptions, ambiguity, and completion using model reasoning.
- Deterministic code persists memory, validates schemas, enforces safety, manages budgets, and executes tools.

## Why This Refactor Exists

Historically, Alfred owned too much meaning in deterministic code:

- turn continuation heuristics
- task-type inference from prompt text
- hard-constraint extraction from keywords
- clarification detection from question-like responses
- completion checks that inferred semantics from regex/phrasing instead of task state

That caused the failures we were seeing:

- unnecessary clarification loops
- weak continuity across turns
- specialist loops that kept searching instead of converging
- low-budget writer fallback being used as a fake completion path

## Current Architecture Direction

The runtime is being reshaped around four ideas:

1. Plaintext turns are interpreted, not classified.
2. Session memory must preserve usable cognition, not just logs.
3. Specialist convergence must be driven by evidence state, not optimistic phase labels.
4. Writer should only run when there is a real chance of producing a reusable output.

## Current Runtime State

This section reflects what is actually implemented today.

### Turn semantics

- Execute-mode turns now go through a structured `turn_interpretation` model call in [runAlfredOrchestratorLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runAlfredOrchestratorLoop.ts).
- Alfred now builds an immutable `objectiveContract` from grounded turn interpretation rather than re-deriving semantics from the raw user message when interpretation is available.
- The contract now behaves as the canonical turn contract for the run:
  - downstream execution receives the same deliverable contract
  - specialist fallback paths no longer infer draft/citation semantics from raw prompt keywords when no explicit task contract is supplied
  - when turn interpretation is unavailable, Alfred now falls back to a deliberately minimal general contract instead of reconstructing article semantics from prompt text
  - lead-execution brief creation in the main turn path now activates only from model-owned `taskType=lead_generation` interpretation rather than pre-interpretation keyword routing
- General-task execution now stays in Alfred's loop: if planner tries to delegate a general task to `research_agent`, runtime rewrites that into direct tool execution instead.
- For those same general-task contracts, the planner-visible agent catalog now hides `research_agent`, so Alfred no longer advertises an unnecessary second semantic planner path for normal general work.
- When a general-task follow-up already has a reusable session artifact, Alfred now prefers direct `file_read` reuse over blindly restarting retrieval.
- `research_agent` has now been removed from the public agent registry and tool-policy surface, so it is no longer a first-class runtime path competing with Alfred for general task semantics.
- Alfred planner responses now carry explicit `responseKind`:
  - `final`
  - `clarification`
  - `progress`
- Planner clarification is no longer inferred from punctuation or text shape in the normal response path.
- Alfred no longer calls a separate completion-evaluator model after successful tool or delegation steps; the same planner gets one reserved reassessment pass instead.

### Session memory and prior-output grounding

- Session working memory now includes:
  - `recentOutputs`
  - `unresolvedItems`
  - `activeThreadSummary`
  - `recentTurns`
- Completed runs can be turned into session output records with explicit availability:
  - `body_available`
  - `metadata_only`
  - `missing`
- Alfred can recover durable recent outputs from prior runs and merge them into runtime session context.
- If a prior output has a stored artifact and `availability=body_available`, Alfred can load a bounded body preview for planning.
- Fresh standalone turns now keep a stricter boundary around stale artifacts: if grounding resolves to `source=message`, Alfred does not inherit prior output-path or artifact obligations unless the current turn explicitly references them.
- Fresh substantive requests now also reject stale `recent_output` grounding when the grounded objective injects prior artifact bindings that were not actually asked for in the current turn.

### Specialist runtime cognition

- Specialist/runtime contexts now carry generic active-work state:
  - `assumptions`
  - `unresolvedItems`
  - `activeWorkItems`
  - `candidateSets`
  - `evidenceRecords`
  - `synthesisState`
- This state is generic by design. It is not article-specific, lead-specific, or game-specific.
- Specialist planner context receives `activeWorkState` directly so the model can plan against current evidence and synthesis readiness.

### Specialist convergence

- Research tasks now default to `requiresAssembly=true`, which prevents premature completion after a single shortlist/search step.
- Specialist planner responses now also use explicit `responseKind`.
- Delegated research contracts default to `clarificationAllowed=false` unless the task contract says otherwise.
- Unsupported long-form `respond` attempts are blocked when evidence and synthesis state do not justify them.
- Evidence readiness is now separated from final completion gaps. Alfred can distinguish:
  - enough evidence to synthesize
  - not yet enough for final polish/citations/artifacts
- When runtime state is clearly `fetch_pending`, search-only replans can be mechanically corrected into fetch/evidence actions.
- When runtime state is clearly `fetch_pending`, repeated `file_read` or `file_read + search` plans can also be corrected into fetch/evidence actions instead of rereading the same stale artifact.
- Planner timeouts during `discovery_complete_fetch_pending` can recover into fetch instead of burning another shortlist/search iteration.
- Specialist discovery source tracking is now constrained to discovery/fetch tool outputs (search/shortlist/fetch), so URLs embedded inside `file_read` memo content no longer poison source discovery or trigger malformed fetch loops.

### Writer readiness

- Specialist runtime now computes shared `writerReadiness` from:
  - evidence readiness
  - synthesis state
  - time budget viability
  - output contract readiness
- Low-budget forced writer fallback is no longer treated as an acceptable completion strategy.
- Search/synthesis loops can reroute into assembly when evidence is ready, rather than waiting for a low-budget emergency finalize path.
- Low-confidence placeholder drafts from failed low-budget or no-output writer passes are no longer persisted as new artifacts by default.
- Writer-quality signals now drive reusable-body classification across runtime memory:
  - specialist loop records last writer output availability and deliverable status
  - assembly tasks only become `complete` when a reusable synthesized body exists
  - persisted artifacts from insufficient writer outputs remain `metadata_only` instead of being treated as finished bodies
- Specialist generation inputs are now rebuilt from the immutable task contract before execution:
  - hardcoded `blog_post` / `memo` recovery defaults are gone from assembly/retry/finalize call sites
  - planner-supplied writer actions are normalized back to contract-derived shape hints and deliverable instructions
  - ranked lists, comparisons, briefs, tables, and other non-article contracts now enter generation as contract-preserving `notes`-style outputs instead of article defaults
- `writer_agent` itself is now a plain generation tool:
  - one bounded generation pass
  - mechanical quality checks
  - artifact persistence
  - no writer-owned intent/review/repair stack

### Output availability contract

- Specialist stop/failure handling now emits explicit output availability:
  - `body_available`
  - `metadata_only`
  - `missing`
- Final contract/failure paths now distinguish:
  - reusable body
  - recoverable metadata only
  - no recoverable output
- Session-output recovery now also respects writer quality metadata, so old placeholder drafts or planning memos no longer re-enter later turns as `body_available`.
- This prevents placeholder or low-evidence outcomes from masquerading as reusable completed drafts.

## Refactor Status By Phase

### Phase 1: Model-Owned Turn Interpretation

Status: substantially implemented

Delivered:

- structured turn interpretation for execute-mode plaintext turns
- immutable turn contract built from grounded interpretation
- clarification now model-signaled instead of punctuation-signaled
- downstream delegated research contracts now preserve interpretation-owned draft/citation/word-count/path semantics instead of re-deriving them from the raw message
- specialist fallback contracts no longer regex-infer draft/citation intent from prompt text

Remaining:

- remove more fallback prompt heuristics where they still influence task setup when model interpretation is unavailable

### Phase 2: Explicit Planner Response Kind

Status: implemented in Alfred and specialist loops

Delivered:

- planner-visible `responseKind`
- explicit distinction between final, clarification, and progress responses

Remaining:

- none material for this phase

### Slice 2: Execution Loop Simplification

Status: implemented for the current runtime boundary

Delivered so far:

- Alfred now prevents general-task delegation to `research_agent` by converting that planner action into direct tool execution inside Alfred's own loop.
- Alfred now also stops advertising `research_agent` to the planner for general-task contracts.
- Alfred can reuse existing session artifacts with direct `file_read` when a general-task follow-up already points to a reusable stored body.
- `research_agent` is no longer registered as a public specialist skill, so the runtime no longer exposes a dead general-purpose delegation target.

Remaining:

- decide whether any non-general research-specialist responsibilities should survive as separate skills or move into Alfred/tool mechanics

### Phase 3: Generic Active Work State

Status: implemented

Delivered:

- generic cognition state across runtime contexts
- planner-visible `activeWorkState`
- recent output registry and durable recent-output recovery

Remaining:

- continue using this state to replace remaining heuristic progression logic

### Phase 4: Evidence-Driven Specialist Convergence

Status: implemented for the current runtime boundary

Delivered:

- evidence-backed response blocking
- `requiresAssembly` for research-style tasks
- evidence readiness separated from completion gaps
- fetch-pending mechanical recovery
- assembly-first rerouting
- explicit output availability in stop/failure paths

Remaining:

- reduce the last specialist loop guards that still encode progression heuristics instead of relying purely on model-produced state plus runtime mechanics

### Phase 5: Writer Readiness Contract

Status: implemented

Delivered:

- shared `writerReadiness`
- viable writer time-window checks
- no forced low-budget writer sink
- no placeholder draft persistence as fresh output by default
- finalization logic distinguishes reusable body vs metadata-only vs missing
- writer core no longer defaults to `section plan -> section passes -> polish`; it is now a bounded one-pass generation tool that drafts directly in the requested shape and reports mechanical quality against the contract
- specialist writer call sites now derive generation format/instructions from the immutable contract and normalize planner-provided writer payloads before execution

Remaining:

- tighten any remaining response paths that still treat weak draft state too optimistically

### Phase 6: Remaining Heuristic Ownership

Status: implemented for the current runtime boundary

Delivered in this phase so far:

- orchestrator fallback objective setup no longer re-derives task type, hard constraints, draft intent, citation intent, or target word count from raw prompt heuristics
- fresh missing-interpretation turns now degrade to a minimal generic contract plus explicit mechanical constraints like requested output path
- canonical lead-brief generation in the main turn path is now interpretation-owned instead of keyword-owned
- specialist schema-repair and writer/finalize guards now key off the passed contract and available tools instead of `research_agent` skill-name semantics
- fallback specialist setup now degrades to a generic minimal specialist contract instead of reintroducing research semantics from skill identity
- Alfred-local direct research now uses mechanical search-to-fetch recovery once enough candidate URLs are discovered, instead of repeatedly re-owning discovery semantics

Residual risk:

- runtime hardening is still needed for noisy real-world evidence quality and planner repetition, but that is now a behavior/reliability problem inside the simplified architecture rather than a duplicate-semantic-ownership problem

### Completion Authority

Status: implemented for the current runtime boundary

Delivered:

- the separate outer completion-evaluator model call has been removed from Alfred's loop
- final `respond` acceptance now flows through the canonical contract gate after the same Alfred planner reassessment path
- successful tool and delegation results now flow back into the same Alfred planner for reassessment, instead of being judged by a second semantic model

Remaining:

- finish collapsing the remaining deterministic contract gate so final-answer acceptance is both single-owner and less heuristic

## Deterministic Code That Should Remain

These should stay deterministic:

- `/commands`
- schema validation
- file path extraction
- tool approval and policy gates
- budget / timeout / cancellation
- persistence and retrieval
- artifact existence checks
- runtime recovery when state already makes the next mechanical step obvious

## Success Criteria

Alfred should behave like:

`reason(current_turn + session_context + recoverable_memory) -> act -> persist -> continue`

Not like:

`classify(prompt with heuristics) -> run fixed branch -> hope it fits`
