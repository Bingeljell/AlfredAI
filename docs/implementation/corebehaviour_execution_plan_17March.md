# Core Behaviour Execution Plan - 17 March

## Purpose

This document is the operational companion to [docs/architecture/corebehaviour_refactor_plan_17March.md](/Users/nikhil/Projects/Alfredv1/docs/architecture/corebehaviour_refactor_plan_17March.md).

The architecture doc explains the target model.
This execution doc explains exactly what we will cut, in what order, in which files, and how we will know each slice is actually done.

## Refactor Rule

- `LLM owns meaning`
- `Tools and skills own mechanics`
- `Runtime owns execution discipline only`

Every slice below must be judged against that rule.

## Slice Status Map

- Slice 1: `done`
  - canonical turn contract introduced
  - turn interpretation now owns delegated contract semantics when available
  - specialist fallback contract no longer regex-infers draft/citation intent from raw prompt text
- Slice 2: `in progress`
  - general tasks now stay in Alfred's loop via direct execution override instead of defaulting to `research_agent`
  - planner-visible agent catalog now hides `research_agent` for general-task contracts, so the planner no longer treats delegation as an equal semantic path
- Slice 3: `done`
  - specialist writer actions are now normalized back to the immutable task contract before execution
  - hardcoded `blog_post`/`memo` recovery defaults have been replaced with contract-derived generation inputs
- Slice 4: `in progress`
- Slice 5: `in progress`
- Slice 6: `in progress`

## Slice 1 - Contract Hardening

Status:
- `done`

Committed in:
- `030b943` `Implement slice 1 turn contract hardening`

Files changed:
- `src/types.ts`
- `src/agent/skills/types.ts`
- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/runSpecialistToolLoop.ts`
- `tests/unit/runAlfredOrchestratorLoop.test.ts`
- `tests/unit/runSpecialistToolLoop.test.ts`

What changed:
- introduced shared canonical turn contract type
- made model turn interpretation authoritative for delegated research semantics when available
- removed specialist fallback regex ownership for draft/citation inference

Exit criteria met:
- delegated research contracts preserve interpretation-owned semantics
- fallback specialist contracts no longer widen semantics from raw prompt text

## Slice 2 - Execution Loop Simplification

Status:
- `in progress`

Objective:
- remove duplicate semantic planning between Alfred orchestrator and research specialist for general plaintext tasks

Primary outcome:
- general tasks should stay in one semantic execution loop instead of being re-planned by a second semantic authority

Files in scope:
- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/runAgentLoop.ts`
- `src/core/runSpecialistToolLoop.ts`
- `src/agent/skills/registry.ts`
- `tests/unit/runAlfredOrchestratorLoop.test.ts`
- `tests/unit/runSpecialistToolLoop.test.ts`

Primary functions/methods to target:
- `runAlfredOrchestratorLoop(...)`
- `buildAlfredPlannerSystemPrompt(...)`
- `evaluateCompletion(...)` call sites / completion flow in orchestrator
- `runAgentLoop(...)`
- `runSpecialistToolLoop(...)`
- `buildSpecialistTaskContract(...)`
- specialist planner invocation + replan loop boundaries

Logic to remove or shrink:
- Alfred deciding semantics, then delegating to a second semantic planner for straightforward research/list work
- specialist planner owning task progression for cases Alfred can execute directly
- replan/replan/replan behavior where the second planner is not adding real value

Logic to keep:
- bounded retries
- budget/deadline checks
- tool execution envelope
- telemetry
- cancellation and approval

Planned code moves:
1. classify which task classes still justify delegation
   - keep delegation for non-general specialist tasks only
   - route general research/synthesis/writing flows through Alfred directly
2. remove `research_agent` as a semantic path for general tasks
3. preserve active work state only as execution memory, not as a second semantic planner contract
4. collapse duplicated completion gates where possible during the same slice if needed to avoid split-brain behavior

Tests to add or update:
- Alfred completes a simple research/list task without delegating to `research_agent`
- Alfred uses search/fetch/read directly and preserves the same turn contract through the loop
- Alfred still delegates when task complexity actually warrants it
- no regression on lead generation delegation path

Exit criteria:
- general tasks no longer require a second semantic planner
- no semantic disagreement between Alfred and specialist for those tasks
- run traces show fewer planning layers and fewer LLM calls for the same task class

Current progress:
- Alfred now rewrites `delegate_agent: research_agent` into direct tool execution for general-task contracts, not just simple ranked-list/list shapes.
- Alfred planner context now filters out `research_agent` for general tasks entirely, keeping the planner's semantic choices aligned with the contract.
- If a general-task follow-up already has a reusable session artifact, Alfred now prefers direct `file_read` handoff instead of defaulting to a fresh search.
- `research_agent` has now been removed from the public agent registry and tool-policy surface, leaving only `lead_agent` and `ops_agent` as registered specialist skills.
- Alfred no longer calls a second completion-evaluator model after successful actions; it reserves one final planner reassessment pass instead, keeping the main planner as the only semantic owner in the normal loop.

Risks:
- deleting delegation too aggressively and harming cases where specialist state still helps
- hidden dependencies in `runSpecialistToolLoop` that are also serving as mechanical helpers

Rollback boundary:
- Slice 2 should land in at least two commits:
  - routing simplification
  - loop cleanup / test updates

## Slice 3 - Writer Demotion

Status:
- `done`

Objective:
- remove `writer` as a separate semantic workflow engine and turn it into contract-preserving generation mode

Primary outcome:
- writer no longer defines or mutates the deliverable shape; it only generates within the existing contract

Files in scope:
- `src/agent/tools/definitions/writerAgent.tool.ts`
- `src/agent/tools/registry.ts`
- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/runSpecialistToolLoop.ts`
- `tests/unit/writerAgentTool.test.ts`
- `tests/unit/runAlfredOrchestratorLoop.test.ts`
- `tests/unit/runSpecialistToolLoop.test.ts`

Primary functions/methods to target:
- `defaultShapeForFormat(...)`
- writer intent pass builder and executor
- writer draft/review/repair pipeline entry points
- writer persistence and output classification
- all orchestrator/specialist call sites that still assume `blog_post` / `memo` defaults

Logic to remove or shrink:
- writer-owned intent pass as a second deliverable-definition system
- writer review/repair as a second semantic validation hierarchy
- format-default fallbacks that can mutate list -> article or article -> memo
- specialist retry paths that call writer with generic `blog_post` semantics

Logic to keep:
- provider abstraction
- timeout management
- artifact persistence
- bounded revision when it preserves the same contract

Planned code moves:
1. demote writer to a `generate_output`-style execution mode
2. feed writer the immutable contract and current evidence packet only
3. remove internal authority to redefine the output shape
4. keep at most one same-contract revision pass where mechanically viable
5. standardize writer outputs so they report contract satisfaction, not their own private success notion

Tests to add or update:
- ranked list task cannot drift into article/blog output on retry
- article task cannot drift into memo/process commentary
- generation retries preserve required fields and output shape
- placeholder or incomplete outputs remain `metadata_only`

Exit criteria:
- writer no longer acts like a second planner
- all writer retries preserve the original deliverable shape
- no `blog_post` fallback paths remain in runtime orchestration for non-article contracts

Current progress:
- specialist default writer inputs now derive from the immutable contract instead of hardcoded `blog_post`
- assembly, retry, and low-budget finalize writer actions now rebuild their instructions/format hints from `preferredOutputShape`, required deliverable, done criteria, and required fields
- planner-supplied writer actions are normalized back to the immutable contract before execution, so explicit `format: "blog_post"` payloads can no longer silently drift ranked-list/list/comparison contracts into article mode
- `writer_agent` is now a plain generation tool: one bounded text-generation pass, mechanical quality checks, artifact persistence, and no writer-owned intent/review/repair sub-pipeline
- writer coverage now validates direct tool behavior rather than the deleted multi-pass workflow

Risks:
- losing some provider-fallback reliability during simplification
- under-specifying generation prompts after removing writer-owned structure

Rollback boundary:
- separate commits for:
  - call-site cleanup
  - writer-core simplification
  - classification/persistence cleanup

## Slice 4 - Single Semantic Validator

Status:
- `in progress`

Objective:
- replace split completion authority with one validator against the canonical turn contract

Primary outcome:
- no more disagreements like:
  - writer says complete
  - specialist says complete
  - Alfred says not complete

Files in scope:
- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/runSpecialistToolLoop.ts`
- `src/memory/sessionOutputs.ts`
- possibly a new shared validator helper under `src/core/` or `src/utils/`
- tests around orchestrator/specialist completion

Primary functions/methods to target:
- Alfred completion evaluation path
- specialist contract gate path
- writer-result output classification handoff
- session output availability derivation

Logic to remove or shrink:
- duplicate semantic completion checks in multiple runtime layers
- completion inferred from artifact existence or local tool-specific success flags

Logic to keep:
- mechanical validation of schema/tool success
- artifact existence checks as supporting evidence only

Planned code moves:
1. define one semantic validator over `TurnContract`
2. route final response acceptance through that validator only
3. reduce specialist/writer completion to evidence reporting, not final semantic judgment
4. keep output states standardized:
   - `complete`
   - `partial`
   - `metadata_only`
   - `missing`

Tests to add or update:
- inner tool success does not bypass validator
- persisted artifact alone does not imply completion
- correct output shape + required fields does satisfy completion
- partial output produces honest partial response, not false success

Current progress:
- the outer completion-evaluator model call is now removed from Alfred's loop
- successful tool/delegation steps now return to the same Alfred planner for one reserved reassessment pass instead of consulting a second semantic model
- contract gating still exists as runtime integrity enforcement on final `respond` actions, but the duplicate post-action authority is gone

Exit criteria:
- one semantic completion authority only
- inner/outer disagreement impossible by design

Risks:
- over-centralizing validation and losing useful local evidence checks

Rollback boundary:
- validator introduction must be landed before deleting old checks, not after

## Slice 5 - Mechanical-Only Guards

Status:
- `pending`

Objective:
- keep runtime safety and anti-stall behavior while removing semantic ownership from guards

Primary outcome:
- guards can stop wasteful execution, but they cannot redefine what the task means

Files in scope:
- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/runSpecialistToolLoop.ts`
- tool execution helpers and input-repair helpers
- tests around guardrail behavior

Primary functions/methods to target:
- prompt-task helpers still re-deriving semantics
- planner-input repair paths that inject semantic defaults
- low-budget finalize / retry guards that change output shape or task ownership
- continuation/task-type/constraint helpers that still own meaning

Logic to remove or shrink:
- `detectObjectiveTaskType(...)`
- `deriveHardConstraints(...)` as a normal-path semantic owner
- `extractTargetWordCount(...)` as a normal-path semantic owner
- specialist guard paths that rewrite semantics instead of only mechanics

Logic to keep:
- timeout and deadline controls
- anti-thrash / repeated no-progress detection
- schema repair
- output-path injection only when contract already requires it
- policy and approval rules

Tests to add or update:
- guardrails stop low-value loops without changing deliverable shape
- low budget does not trigger semantic mutation
- schema repair does not inject new task meaning

Exit criteria:
- guards are mechanical only
- semantic task ownership remains in the contract and validator

Risks:
- removing too many helpers at once and destabilizing runtime reliability

Rollback boundary:
- land guard deletions in small commits grouped by function family

## Slice 6 - Memory Cleanup

Status:
- `pending`

Objective:
- make memory support continuity without hijacking fresh intent

Primary outcome:
- prior work is usable context, not a silent semantic override

Files in scope:
- `src/services/chatService.ts`
- `src/memory/sessionOutputResolver.ts`
- `src/memory/sessionOutputs.ts`
- `src/memory/sessionStore.ts`
- `src/core/runAlfredOrchestratorLoop.ts`

Primary functions/methods to target:
- session-output recovery
- prior-output grounding
- stale-artifact demotion logic
- output availability persistence

Logic to remove or shrink:
- any recovery path that turns stale artifacts into binding task meaning without explicit current-turn grounding

Logic to keep:
- recent outputs and artifacts as advisory context
- durable run recovery
- body vs metadata vs missing classification

Tests to add or update:
- fresh turn does not get hijacked by stale prior artifact
- explicit follow-up does reuse prior artifact/body
- metadata-only prior outputs stay truthful

Exit criteria:
- continuity works without stale-context takeover

Current progress:
- stale-artifact takeover was already bounded earlier in the refactor through fresh-turn demotion and recent-output hygiene
- Alfred fallback objective contracts are now intentionally minimal when model turn interpretation is unavailable:
  - no fallback draft/citation/word-count inference from raw prompt text
  - no pre-interpretation keyword routing into lead execution
  - explicit requested output paths remain mechanical constraints only
- main-loop lead brief generation now activates only from model-owned `taskType=lead_generation` interpretation in the primary turn setup path
- regression coverage now proves that missing turn interpretation yields a generic `general` contract instead of reconstructing article semantics from prompt text

Risks:
- over-pruning memory reuse and hurting legitimate follow-up behavior

Rollback boundary:
- memory grounding changes should land separately from storage/schema changes

## Deletion Watchlist

These are the main semantic-ownership hot spots that should disappear by the end of this refactor:

- orchestrator semantic planner authority beyond contract interpretation
- specialist semantic planner authority for simple tasks
- writer intent/review/repair as independent semantic authorities
- raw prompt regex/keyword ownership for task meaning
- duplicate completion evaluators with conflicting answers

## Test Discipline

Each slice must include one of:

- a new regression test for the deleted semantic layer
- or an updated test proving the new authority model

No slice should be merged only on architectural intention.

## Manual Verification Themes

After each slice, manual checks should cover:

1. ranked list task
2. article task
3. lead/company list task
4. follow-up rewrite task
5. local tool/skill task

For each, verify:
- no deliverable drift
- no stale-context hijack
- no contradictory completion judgments
- fewer unnecessary semantic loops

## Immediate Next Move

The next coding slice is Phase 6 cleanup on top of the now-simplified loop.

Start by removing the remaining prompt-heuristic ownership from Alfred/specialist setup so final-answer acceptance and execution routing come from the immutable turn contract plus planner reasoning, not helper inference.
