# Core Behaviour Refactor

## Goal

Make Alfred behave more like a general-purpose second brain and less like a deterministic workflow engine.

Design rule:

- `LLM owns semantics`
- `Runtime owns mechanics`

That means:

- Alfred interprets user intent, continuity, assumptions, ambiguity, and completion using model reasoning.
- Deterministic code persists memory, validates schemas, enforces safety, manages budgets, and executes tools.

## Problem

Today Alfred still has too much heuristic ownership over meaning-bearing parts of execution:

- turn continuation heuristics
- task-type inference
- hard-constraint extraction from prompt text
- clarification detection from question-like text
- completion gates that infer semantics from keywords instead of from an interpreted task contract

This causes capability loss:

- unnecessary clarification loops
- poor convergence on open-ended research tasks
- runtime forcing the wrong move under budget pressure
- weak continuity across turns compared to a strong direct frontier-model chat

## Refactor Principles

### 1. Plaintext turns are interpreted, not classified

Normal user prompts should not be routed by regex or keyword ownership.

Instead, each turn should produce a model-owned interpretation contract that answers:

- what is the user trying to do
- is this a continuation
- is prior work being referenced
- what assumptions are reasonable
- what information is missing
- is missing information actually blocking
- what does success look like

### 2. Clarification is a strategic action

Clarification should not be inferred because a planner response contains a question mark.

Clarification should happen only when the model explicitly marks ambiguity as blocking.

### 3. Memory should support cognition, not just logging

Alfred needs:

- live context
- working memory
- durable retrieval

And within working memory, Alfred needs more than recent outputs. It needs active thread cognition:

- assumptions
- unresolved items
- active work items
- candidate sets
- evidence records
- synthesis readiness

### 4. Specialist progression should be evidence-driven

The specialist loop should not treat `phase=complete/respond` as meaningful unless the current evidence state supports that claim.

The runtime should track:

- evidence accumulation
- candidate accumulation
- synthesis readiness
- no-progress loops
- remaining budget

The model should decide what the next move is from that state.

### 5. Writer should only run when writer-ready

Writer should not be used as a low-budget “finalize whatever you can” sink.

Writer should only be invoked when:

- there is enough evidence to synthesize honestly
- there is enough remaining time for a real pass
- the task contract allows synthesis

If not, Alfred should continue gathering evidence or return an honest partial state.

## Refactor Roadmap

### Phase 1: Model-Owned Turn Interpretation

Files:

- `src/core/runAlfredOrchestratorLoop.ts`

Changes:

- Add a structured `turn_interpretation` model call for execute-mode plaintext turns.
- Use it to build a stable turn contract:
  - grounded objective
  - required deliverable
  - done criteria
  - assumptions
  - target word count hint
  - output-path hint
  - draft/citation intent
  - clarification-needed flag
- Keep deterministic fallback only when no model interpretation is available.

Acceptance:

- turn semantics are no longer primarily owned by prompt heuristics
- clarification is driven by structured interpretation, not text-shape guesses

### Phase 2: Explicit Planner Response Kind

Files:

- `src/core/runAlfredOrchestratorLoop.ts`

Changes:

- Extend planner output with `responseKind`:
  - `final`
  - `clarification`
  - `progress`
- Stop inferring clarification from question-like response text.

Acceptance:

- planner must explicitly label clarification vs final response

### Phase 3: Generic Active Work State

Files:

- `src/types.ts`
- `src/services/chatService.ts`
- `src/core/runSpecialistToolLoop.ts`
- new helpers under `src/memory/` or `src/core/`

Changes:

- Add generic session/runtime cognition state:
  - `activeWorkItems`
  - `candidateSets`
  - `evidenceRecords`
  - `assumptions`
  - `unresolvedItems`
  - `synthesisState`

Important:

- not domain-specific
- not “games”, “articles”, or “leads”
- reusable across any task shape

Acceptance:

- Alfred can converge on ranked lists, comparisons, drafts, and research packets without domain-specific control logic

Implementation status:

- Shared runtime scaffolding is landed across Alfred, specialist, and lead tool contexts:
  - `assumptions`
  - `unresolvedItems`
  - `activeWorkItems`
  - `candidateSets`
  - `evidenceRecords`
  - `synthesisState`
- Specialist planner context now receives a generic `activeWorkState` snapshot derived from runtime evidence, candidates, assumptions, and synthesis readiness.
- Remaining work in this phase is to let the model rely on this state for stronger convergence decisions before replacing more heuristic progression guards.

### Phase 4: Evidence-Driven Specialist Convergence

Files:

- `src/core/runSpecialistToolLoop.ts`

Changes:

- Replace overconfident phase labels with evidence-driven readiness signals
- track candidate coverage and support strength generically
- make model plan against real coverage state

Acceptance:

- specialist loop stops thrashing between discovery, clarification, and synthesis

Implementation status:

- Specialist response blocking now consults generic active-work evidence state, not just draft-word or citation counters.
- Unsupported long-form `respond` attempts are blocked when the runtime has no evidence backbone or synthesis is still unresolved.
- Failure telemetry and fallback summaries now carry unresolved-work and synthesis-state detail so debugging can see where convergence failed.
- Research tasks now carry `requiresAssembly`, so the specialist phase machine no longer marks non-draft research asks as `complete` after a single shortlist/search step.
- Synthesis readiness now distinguishes evidence readiness from final completion gaps (for example missing citations or not-yet-written artifacts), which lets the model assemble from evidence before polishing the final deliverable.

### Phase 5: Writer Readiness Contract

Files:

- `src/core/runSpecialistToolLoop.ts`
- `src/agent/tools/definitions/writerAgent.tool.ts`

Changes:

- introduce minimum writer readiness:
  - evidence ready
  - time budget ready
  - output contract ready
- remove low-value forced placeholder drafting as a “completion” strategy

Acceptance:

- writer either runs with real chance of success or does not run

Implementation status:

- Specialist runtime now computes a shared `writerReadiness` assessment from evidence coverage plus active-work synthesis state.
- Writer-evidence rerouting, revise-vs-retrieve retries, and low-budget finalize decisions now consume that shared readiness state instead of duplicating scattered threshold logic.
- Remaining work in this phase is to keep tightening final-response paths so placeholder or low-evidence drafts cannot masquerade as complete outcomes.
- Synthesis-phase search loops can now be rerouted into an assembly pass once evidence readiness is satisfied, instead of waiting to hit a low-budget emergency fallback.

### Phase 6: Remaining Heuristic Ownership

Implementation status:

- Specialist planner now has explicit `responseKind` and research contracts default to `clarificationAllowed: false`, which blocks unnecessary follow-up questions once Alfred has already accepted defaults.
- Major heuristic ownership still remains in:
  - `buildSpecialistTaskContract` prompt regexing for draft/citation/word-count intent
  - orchestrator-side objective/task helpers (`detectObjectiveTaskType`, `deriveHardConstraints`, `extractTargetWordCount`)
  - specialist loop guards that still encode runtime progression heuristics
- The runtime is now closer to `LLM owns semantics / runtime owns mechanics`, but Phase 6 is still the main unfinished cleanup pass.

### Phase 6: Reduce Remaining Heuristic Ownership

Files:

- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/runSpecialistToolLoop.ts`

Targets:

- `detectObjectiveTaskType`
- `deriveHardConstraints`
- `extractTargetWordCount`
- clarification detectors
- phrase-based continuation ownership

Acceptance:

- heuristics become fallback helpers, not the source of truth for meaning

## Deterministic Code That Should Remain

These should stay deterministic:

- `/commands`
- schema validation
- file path extraction
- tool approval
- budget / timeout / cancellation
- persistence and retrieval
- artifact existence checks

## Success Criteria

Alfred should behave like:

`reason(current_turn + session_context + recoverable_memory) -> act -> persist -> continue`

Not like:

`classify(prompt with heuristics) -> run fixed branch -> hope it fits`
