# Core Behaviour Refactor Plan - 17 March

## Purpose

This document replaces incremental patch thinking with a full runtime simplification plan.

The target is not to make Alfred a more heavily guided workflow engine. The target is to make Alfred behave like a coherent second-brain agent with one semantic contract per turn and only mechanical runtime guardrails.

Design rule:

- `LLM owns meaning`
- `Tools and skills own mechanics`
- `Runtime owns execution discipline, persistence, and safety`

## Why We Are Changing Direction

The current runtime has accumulated too many semantic control layers:

- outer orchestrator planner
- research specialist planner
- writer intent pass
- writer draft pass
- writer review pass
- writer repair pass
- outer completion evaluator

Those layers were added for observability, retries, and guardrails, but they now create the dominant failure mode:

- the task is reinterpreted multiple times
- intermediate layers can widen or mutate the deliverable
- one bad branch poisons downstream steps
- inner loops can claim success while outer validation rejects the result
- failure probability rises as steps and layers increase

That is the opposite of the intended second-brain behavior.

## Architectural Decision

We will refactor Alfred toward a simpler model:

1. `Turn interpretation`
   - one semantic pass
   - produces one immutable turn contract
   - this is the only place that defines the deliverable

2. `Execution loop`
   - one bounded loop
   - uses search / fetch / read / write / extract / enrich / edit / shell / skills as needed
   - the same turn contract remains in force throughout the run

3. `Generation mode`
   - drafting/writing is not a separate semi-autonomous workflow engine
   - it is one execution mode inside the same turn contract
   - no format or deliverable mutation during retries

4. `Single semantic validator`
   - one authority checks whether the current output satisfies the original turn contract
   - all other checks are mechanical only

5. `Mechanical guards only`
   - timeout and budget
   - thrash / repeated low-value action detection
   - schema validity
   - approval/safety policy
   - artifact persistence and retrieval
   - tool/skill execution success
   - no prompt-text semantic ownership

## What We Are Intentionally Removing

The following systems should no longer own semantics once this refactor is complete:

- outer orchestrator planner deciding task meaning separately from turn interpretation
- research specialist planner as an independent semantic authority
- writer intent/draft/review/repair stack as a second brain for output definition
- outer completion evaluator acting as a separate semantic judge after other semantic judges have already run
- prompt regexing / keyword extraction for task type, continuation, hard constraints, and completion intent

This does not mean we remove all loops or all structure. It means we remove duplicate semantic ownership.

## What Stays

These remain valid runtime responsibilities:

- turn/run/session persistence
- tool and skill registry
- tool schema validation
- approval gates
- cancellation / interruption
- deadline and budget accounting
- artifact creation and retrieval
- mechanical anti-stall behavior
- memory hydration and persistence

## Target Runtime Model

The target runtime for a normal plaintext turn is:

`reason(current_message + session_context + recoverable_memory) -> contract -> execute -> validate -> persist`

Not:

`planner -> specialist planner -> writer planner -> writer reviewer -> outer evaluator`

## Universal Contract Model

This architecture must work across all task families, not only writing.

Examples:

- `Write an article about X`
- `Give me a ranked list of games for kids`
- `Find MSPs/SIs in Texas with URLs and contact emails`
- `Denoise this video and add an end slate using my local CLI`

The task changes.
The contract changes.
The tools/skills change.
The runtime model does not change.

## Core Principles

### 1. One turn, one contract

Every plaintext turn gets a single turn contract containing:

- grounded objective
- required deliverable
- explicit constraints
- success criteria
- assumptions
- blocking unknowns
- preferred output shape
- required fields
- artifact expectations

No downstream layer can redefine the deliverable.

### 2. Skills/tools execute mechanics, not semantics

Skills and tools should not reinterpret the task. They should execute bounded work.

Examples:

- `web_search` returns results
- `web_fetch` retrieves pages
- `lead_extract` extracts entities
- `video_edit` applies denoise and end slate
- `generate_output` produces user-facing prose/list/csv in the contract's required shape

### 3. Generation is a mode, not a planner hierarchy

We are demoting "writer" from a separate semantic workflow to a generation backend.

That means:

- no separate writer-owned task definition
- no separate writer-owned retry semantics
- no format mutation on retry
- no article-vs-list drift because a fallback path used `blog_post`

If a task needs long-form generation, Alfred can enter `generate_output` mode within the existing contract.

### 4. Semantic validation happens once

A single validator checks:

- does the output satisfy the contract?
- is the required shape correct?
- are required fields present?
- are unsupported claims exposed honestly?
- if incomplete, is the current state still useful as partial output or metadata only?

All other validation is mechanical.

### 5. Memory should preserve cognition, not just logs

Session memory should retain:

- recent conversation
- active thread summary
- recent outputs
- unresolved items
- assumptions
- artifacts
- metadata about whether output body is reusable

Durable logs remain for recovery, but they must not silently override the current turn.

## Migration Strategy

We will not do a reckless one-shot delete. We will cut semantic ownership layer by layer while keeping the system runnable.

### Phase A - Freeze semantic authority at turn interpretation

Goal:
- make turn interpretation the only source of deliverable semantics

Work:
- define a stricter `TurnContract` as the canonical structure
- ensure every downstream path receives the same contract
- remove downstream deliverable rewriting
- make grounded objective narrowing stricter so fresh user requests are not widened casually

Acceptance:
- downstream systems can add observations, not redefine deliverable shape

### Phase B - Collapse duplicate planners into one execution loop

Goal:
- remove separate semantic planning layers for normal execution

Work:
- simplify Alfred runtime to one primary loop
- treat specialist loops as mechanical execution helpers or remove them where unnecessary
- for straightforward tasks, Alfred should directly choose/search/fetch/read/write without delegating to a second semantic planner
- preserve bounded retries and budgets, but only in the one loop

Acceptance:
- no separate orchestrator-vs-specialist semantic disagreement on the same turn

### Phase C - Replace writer with generation mode

Goal:
- remove `writer` as a semi-autonomous sub-agent

Work:
- replace `writer_agent` / `article_writer` semantics with a contract-preserving generation tool/mode
- keep provider abstraction and output persistence where useful
- remove internal intent/review/repair authority as semantic owners
- preserve one generation pass plus optional same-contract revision pass only when mechanically viable

Acceptance:
- retries can improve an output but cannot change list -> article, article -> memo, etc.

### Phase D - Install one semantic validator

Goal:
- unify completion judgment

Work:
- create one validation layer that evaluates output against the immutable turn contract
- remove duplicate completion judgments in specialist and writer paths
- standardize output states:
  - `complete`
  - `partial`
  - `metadata_only`
  - `missing`

Acceptance:
- inner and outer runtime cannot disagree about whether the task is complete

### Phase E - Retain only mechanical guards

Goal:
- preserve runtime safety without semantic drift

Work:
- keep timeout/deadline controls
- keep schema/tool validation
- keep anti-thrash logic
- keep artifact persistence/recovery
- keep approval rules
- explicitly remove prompt-keyword semantic ownership from mechanical guards

Acceptance:
- runtime can stop bad loops without redefining the task

### Phase F - Simplify memory integration

Goal:
- make memory support continuity without hijacking the current turn

Work:
- preserve recent outputs and artifacts as advisory context
- require explicit current-turn grounding before prior output becomes a binding input
- make reused outputs truthfully classified as:
  - `body_available`
  - `metadata_only`
  - `missing`

Acceptance:
- prior runs help, but do not silently mutate fresh requests

## Implementation Order

### Slice 1 - Contract hardening

Files likely affected:

- `src/core/runAlfredOrchestratorLoop.ts`
- `src/types.ts`
- memory helpers and turn state helpers

Tasks:

- define the final canonical turn contract shape
- remove any downstream contract rewriting
- narrow interpretation defaults so Alfred does not widen tasks casually
- document contract fields explicitly

### Slice 2 - Execution loop simplification

Files likely affected:

- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/runAgentLoop.ts`
- `src/core/runSpecialistToolLoop.ts`

Tasks:

- decide which task classes still justify delegation
- move simple research/list tasks back into Alfred's main loop
- reduce specialist runtime from semantic planner to execution helper where retained
- delete duplicated plan/replan logic where no longer needed

### Slice 3 - Writer demotion

Files likely affected:

- `src/agent/tools/definitions/writerAgent.tool.ts`
- tool registry wiring
- any writer-related orchestration glue

Tasks:

- turn writer into `generate_output` semantics or equivalent
- keep provider failover and persistence only if they preserve the same contract
- remove format-default fallback behavior that can mutate deliverable shape
- remove independent review authority

### Slice 4 - Single validator

Files likely affected:

- `src/core/runAlfredOrchestratorLoop.ts`
- shared validation helper(s)
- session output classification helpers

Tasks:

- implement one semantic validator against `TurnContract`
- standardize completion and partial-result semantics
- route all response completion through the same validator

### Slice 5 - Mechanical-only runtime guards

Files likely affected:

- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/runSpecialistToolLoop.ts`
- tool envelope / execution helpers

Tasks:

- keep timeouts, schema repair, anti-thrash, artifact persistence
- remove heuristic task typing / keyword ownership
- ensure low-value loop detection remains task-agnostic

### Slice 6 - Memory cleanup

Files likely affected:

- `src/services/chatService.ts`
- `src/memory/sessionOutputResolver.ts`
- `src/memory/sessionOutputs.ts`
- `src/memory/sessionStore.ts`

Tasks:

- preserve reusable outputs and metadata truthfully
- simplify how prior outputs are surfaced into new turns
- ensure fresh turns are not hijacked by stale artifacts

## Success Metrics

The target success bar is operational, not aesthetic.

Primary target:

- `95%+ success rate` on representative manual task suites

Representative task suites must include:

- article generation from fetched evidence
- ranked recommendation list from web research
- lead/company list with URLs and emails
- follow-up rewrite of prior output in the same session
- local skill/tool execution task such as file editing or video CLI execution

Measured failure classes should include:

- wrong deliverable shape
- premature clarification
- stale-context hijack
- false completion
- low-value loop exhaustion
- writer/generation timeout without honest fallback

## Non-Goals

This plan does not aim to:

- eliminate all structure or all runtime boundaries
- remove telemetry or observability
- make every skill/tool call fully free-form and unsafe
- support all task categories in one cut before migration slices are validated

## Risks

### Risk: removing too much structure at once

Mitigation:
- phase the cutover
- keep mechanical guards during simplification
- maintain regression tests per slice

### Risk: loss of observability

Mitigation:
- keep run events and execution traces
- simplify semantics, not telemetry

### Risk: new runtime regressions during planner removal

Mitigation:
- land in small logical commits
- keep the system runnable after each slice
- add targeted regression tests for each deleted semantic layer

## Immediate Next Moves

1. Lock the target architecture in code/docs terminology via the canonical `TurnContract`.
2. Identify the exact semantic owners to delete first in the current runtime.
3. Cut simple research/list tasks out of the specialist semantic planner path.
4. Demote writer into contract-preserving generation mode.
5. Replace duplicate completion logic with one semantic validator.

## Definition of Done

This refactor is done when Alfred can reliably handle common plaintext tasks with:

- one semantic contract per turn
- one execution loop per task
- one semantic validator
- tools/skills handling bounded mechanics
- memory supporting continuity without hijacking fresh intent
- no deliverable-shape drift across retries
- no contradictory inner-vs-outer completion judgments
- sustained `95%+` success on the agreed manual task suite
