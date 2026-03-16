# Memory Implementation Plan

## Goal

Implement the memory model described in [docs/spec.md](/Users/nikhil/Projects/Alfredv1/docs/spec.md) so Alfred behaves like a continuous agent across turns without relying on brittle prompt regex or keyword classifiers.

The target architecture is:

1. `live context`
2. `session working memory`
3. `durable memory`

Deterministic code should only handle storage, retrieval, validation, safety, and runtime guardrails. Plaintext prompt interpretation should stay model-driven unless the user explicitly invokes a deterministic `/command`.

## Design Constraints

- Do not add new regex- or keyword-based prompt routing for normal user turns.
- Keep `/commands` as the only deterministic user-intent override.
- Preserve session isolation.
- Store meaningful outputs as session assets, not just final assistant summaries.
- Make memory reusable across future skills, not just writing.

## Target Behavior

### 1. Live Context

Purpose:
- handle immediate follow-ups like `paste it`, `rewrite that`, `do the same but shorter`

Rules:
- recent user and assistant turns stay available in raw conversational form
- follow-up grounding should use model reasoning over session state, not deterministic keyword checks
- recent turns should not be prematurely compacted into summaries

### 2. Session Working Memory

Purpose:
- compact state for the active thread without replaying all run logs every turn

Must track:
- active objective/thread summary
- recent outputs
- recent artifacts
- unresolved items
- whether a prior output body is available, metadata-only, or missing

### 3. Durable Memory

Purpose:
- full auditability and later retrieval

Must include:
- run records
- tool outputs and events
- daily transcripts
- retrievable artifact handles

Durable memory should not be injected wholesale into the active prompt. Alfred should retrieve from it when live context and session working memory are no longer enough.

## Data Model Changes

Add a `SessionOutputRecord` to session working memory.

Suggested shape:

- `id`
- `kind`
- `runId`
- `createdAt`
- `title`
- `summary`
- `artifactPath`
- `contentPreview`
- `availability`
- `metadata`

Suggested `availability` states:

- `body_available`
- `metadata_only`
- `missing`

Suggested `kind` values:

- `article`
- `draft`
- `research_packet`
- `lead_csv`
- `lead_set`
- `notes`
- `generic_output`

Suggested `metadata` fields:

- `wordCount`
- `citationCount`
- `outputFormat`
- `tone`
- `topic`
- `requestedOutputPath`

## Runtime Changes

### Phase 1: Session Output Registry

Files:
- `src/types.ts`
- `src/services/chatService.ts`
- `src/memory/sessionStore.ts`

Tasks:
- extend `SessionWorkingMemory` with `recentOutputs`, `unresolvedItems`, and `activeThreadSummary`
- build bounded session output records from completed runs
- carry output records into `SessionPromptContext`

Acceptance criteria:
- a completed run leaves behind structured memory of what was produced
- Alfred can distinguish between "I have the full draft" and "I only know a draft existed"

### Phase 2: Default Writer Persistence

Files:
- `src/agent/tools/definitions/writerAgent.tool.ts`
- `src/core/runSpecialistToolLoop.ts`
- `src/core/runAlfredOrchestratorLoop.ts`

Tasks:
- persist meaningful writer outputs to a session-scoped default artifact path when no explicit path is provided
- register those artifacts in run state and session working memory
- preserve metadata even when persistence fails

Suggested path pattern:
- `workspace/alfred/sessions/<sessionId>/outputs/<runId>-article.md`

Acceptance criteria:
- successful writer runs always produce either:
  - a retrievable body artifact, or
  - a metadata-only session output record

### Phase 3: Session Artifact Resolver

Files:
- `src/core/runAlfredOrchestratorLoop.ts`
- new helper under `src/memory/` or `src/core/`

Tasks:
- resolve the current turn against recent outputs, recent artifacts, and last completed run
- choose the most relevant prior output through model-assisted grounding rather than deterministic keyword matching
- expose the resolved prior output to planner/evaluator prompts

Acceptance criteria:
- follow-up turns can operate on prior outputs without needing exact phrasing

### Phase 4: Output Availability Contract

Files:
- `src/types.ts`
- `src/core/runAlfredOrchestratorLoop.ts`
- `src/services/chatService.ts`

Tasks:
- make output availability explicit in turn state and session memory
- teach Alfred to respond honestly based on availability:
  - `body_available` -> operate directly
  - `metadata_only` -> explain what is known and offer regeneration
  - `missing` -> say so clearly

Acceptance criteria:
- Alfred never claims it can paste or rewrite a body it cannot actually retrieve

### Phase 5: Durable Retrieval Bridge

Files:
- `src/memory/`
- `src/runs/runStore.ts`
- future `rag_memory_query` path

Tasks:
- add deterministic retrieval helpers over recent session run history and artifacts
- later connect those helpers to QMD-backed Markdown retrieval for older memory

Acceptance criteria:
- durable memory is usable by Alfred, not just stored for debugging

## Regex Reduction Plan

The current orchestrator still uses deterministic prompt-shape helpers for:

- follow-up continuation detection
- task-type inference
- hard-constraint inference
- target word-count inference
- clarification detection
- completion gating heuristics

These should be reduced in stages:

1. move follow-up grounding to model-assisted session-state resolution
2. move task/constraint interpretation to model-produced execution state
3. keep deterministic parsing only for:
   - slash commands
   - explicit path extraction
   - approval/safety rules
   - schema validation
   - runtime budgets

## Commit Plan

Commit 1:
- add this implementation document
- update progress/changelog

Commit 2:
- add session output registry types and working-memory persistence
- add tests for session memory continuity
- update progress/changelog

Commit 3:
- add default writer persistence to session-scoped artifacts
- add tests for implicit writer artifact creation
- update progress/changelog

Commit 4:
- add session artifact resolver and wire session outputs into planner context
- reduce deterministic follow-up ownership
- add tests for rewrite/paste follow-ups
- update progress/changelog

Commit 5:
- add durable retrieval bridge scaffolding
- update docs and tests

## Acceptance Tests

These examples are representative continuity cases, not deterministic phrase handlers. Normal plaintext follow-ups should resolve through session state and model reasoning rather than regex matches on specific wording.

Writing:
- turn 1: research and write an article
- turn 2: `paste it here`
- expected: Alfred pastes the stored body without pretending it is missing

Rewrite:
- turn 1: research and write an article
- turn 5: revise the prior draft with a different tone or objective
- expected: Alfred resolves the prior session output generically and either reuses the stored body or explains truthfully what is still recoverable

Metadata-only recovery:
- turn 1: article run completed but body artifact missing
- turn 2: follow up asking to reuse or paste the prior output
- expected: Alfred says it remembers the article and can regenerate, instead of pretending it never existed

Cross-skill continuity:
- produce leads, notes, or a research packet in one turn
- reference them later in the same session
- expected: the same session-output resolution path works without task-specific prompt filters

## Implementation Status

- Completed:
  - Phase 1 session output registry
  - Phase 2 default writer persistence
  - Phase 3 session artifact resolver over working-memory outputs
  - Phase 5 initial durable retrieval bridge scaffolding via run-history recovery and artifact body previews
- Pending:
  - Phase 4 output-availability contract enforcement across all user-facing response paths
  - durable retrieval beyond recent run history (`rag_memory_query` / QMD bridge)
  - removal of remaining regex-style orchestration heuristics that still own task typing, constraints, and clarification detection
