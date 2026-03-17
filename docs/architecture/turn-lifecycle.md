# Alfred Turn Lifecycle

This document describes the current runtime flow in the codebase today, including session memory, turn grounding, prior-output recovery, and specialist execution.

## Scope

- request entry via `POST /v1/chat/turn`
- thread and turn control plane
- Alfred orchestrator loop
- direct tool execution and specialist delegation
- session memory + durable output recovery
- run persistence and telemetry

## 1) Session and run entry

1. `ChatService.handleTurn` receives `{ sessionId, message, requestJob? }`.
2. Session existence is validated.
3. `/newsession` resets working memory and writes a synthetic completed run.
4. A `RunRecord` is created:
   - `queued` when `requestJob=true`
   - otherwise `running`
5. Route events are emitted.
6. Working memory is updated immediately with:
   - new user turn
   - active objective
   - thread/session summary scaffolding

Code:

- [chatService.ts](/Users/nikhil/Projects/Alfredv1/src/services/chatService.ts)

## 2) Thread runtime

7. ChatService submits a `TurnOp(type="UserInput")` to `ThreadRuntimeManager`.
8. `ThreadRuntime` serializes operations per session.
9. Queue/start/complete/fail watcher events are emitted.

Code:

- [threadRuntime.ts](/Users/nikhil/Projects/Alfredv1/src/core/threadRuntime.ts)

## 3) Turn runtime shell

10. `TurnRuntime.dispatch(UserInput)` enters `running`.
11. `TurnStarted` is emitted.
12. Periodic turn progress heartbeats begin.
13. `executeRunCore` is called.
14. Outcome is normalized into:
   - `TurnComplete`
   - or `TurnAborted`
15. Active turn context is cleared.

Additional ops:

- `Cancel`
- `Interrupt`
- `Approve`
- `Reject`
- `Shutdown`

Code:

- [turnRuntime.ts](/Users/nikhil/Projects/Alfredv1/src/core/turnRuntime.ts)

## 4) Run core and ReAct entry

16. `executeRunCore` marks the run `running`.
17. Run-level heartbeat starts.
18. `runReActLoop(sessionId, message, runId, options)` begins.
19. Session context is built from working memory.
20. Durable recent outputs are recovered from prior runs and merged into runtime session context.
21. Daily notes are appended.
22. Approval gate is applied.
23. `runAlfredOrchestratorLoop(...)` is called.

Code:

- [chatService.ts](/Users/nikhil/Projects/Alfredv1/src/services/chatService.ts)
- [runReActLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runReActLoop.ts)
- [sessionOutputResolver.ts](/Users/nikhil/Projects/Alfredv1/src/memory/sessionOutputResolver.ts)

## 5) Turn grounding and interpretation

24. Alfred grounds the current turn against:
   - current user message
   - recent conversation
   - session working memory
   - recent durable outputs
25. If a prior session output is referenced/resolved, Alfred can attach:
   - output metadata
   - artifact path
   - bounded body preview when available
26. Execute-mode plaintext turns go through structured `turn_interpretation`.
27. Alfred builds an immutable `objectiveContract` for the turn.
28. If `groundedSource=message`, stale prior artifact obligations are stripped unless explicitly referenced in the current turn.
29. If session grounding tries to bind a fresh substantive request onto a stale prior artifact path/memo that the user did not actually reference, runtime demotes that grounding back to `source=message`.

Code:

- [runAlfredOrchestratorLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runAlfredOrchestratorLoop.ts)

## 6) Alfred orchestrator loop

30. Alfred initializes turn state and emits:
   - `alfred_loop_started`
   - `alfred_objective_contract_created`
   - `alfred_turn_state_updated`
31. Runtime determines:
   - `turnMode`: `diagnostic` or `execute`
   - `executionPermission`: `execute` or `plan_only`
32. Diagnostic turns return run-analysis output without executing specialists/tools.
33. Execute turns enter the bounded planner loop.

Planner context includes:

- turn contract
- current turn state
- available tools
- available agents
- session context
- resolved session output, when present
- body preview, when present

Planner output is structured and uses one action:

- `respond`
- `delegate_agent`
- `call_tool`

Planner responses also include explicit `responseKind`:

- `final`
- `clarification`
- `progress`

Code:

- [runAlfredOrchestratorLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runAlfredOrchestratorLoop.ts)

## 7) Alfred response and completion handling

34. If Alfred chooses `respond`, runtime checks turn completion against the immutable contract.
35. If the response is insufficient, Alfred emits contract-block telemetry and continues iterating.
36. Clarification is only valid when planner explicitly marks `responseKind=clarification`.

Code:

- [runAlfredOrchestratorLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runAlfredOrchestratorLoop.ts)

## 8) Direct tool execution path

36. Alfred validates tool existence and approval requirement.
37. Tool input JSON is parsed and schema-validated.
38. Tool executes and the result is persisted as a tool call.
39. Alfred updates turn state and reruns completion evaluation.

Code:

- [runAlfredOrchestratorLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runAlfredOrchestratorLoop.ts)

## 9) Specialist delegation path

40. Alfred validates target skill from the runtime registry.
41. It emits `agent_delegated`.
42. `runAgentLoop(...)` dispatches to:
   - `lead_agent`
   - `research_agent`
   - `ops_agent`
43. On completion, Alfred records delegation result and reruns completion evaluation.

Code:

- [runAgentLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runAgentLoop.ts)
- [registry.ts](/Users/nikhil/Projects/Alfredv1/src/agent/skills/registry.ts)

## 10) Specialist loop

44. `runSpecialistToolLoop` starts with a specialist task contract.
45. Research-style contracts now usually carry:
   - `requiresAssembly`
   - `clarificationAllowed`
46. Specialist loop iterates through plan -> act -> observe -> replan under budgets.
47. Runtime derives generic `activeWorkState` from observed work:
   - assumptions
   - active work items
   - candidate sets
   - evidence records
   - unresolved items
   - synthesis state
48. Runtime also derives `writerReadiness` from:
   - evidence readiness
   - synthesis state
   - time budget
   - output contract readiness
49. Specialist planner receives both `activeWorkState` and `writerReadiness`.

Current runtime mechanics in this loop include:

- schema-recovery for planner/tool input
- clarification blocking when task contract disallows it
- unsupported long-form response blocking without evidence backing
- fetch-pending mechanical recovery
- assembly-first rerouting when synthesis is ready
- viable-writer-window enforcement
- output-path injection when appropriate

Code:

- [runSpecialistToolLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runSpecialistToolLoop.ts)

## 11) Output availability semantics

50. Specialist stop/failure handling now distinguishes:
   - `body_available`
   - `metadata_only`
   - `missing`
51. This state is emitted in specialist stop telemetry and used in failure summaries.
52. Session output records also carry availability so later turns can reason about whether a body is actually reusable.

Code:

- [runSpecialistToolLoop.ts](/Users/nikhil/Projects/Alfredv1/src/core/runSpecialistToolLoop.ts)
- [types.ts](/Users/nikhil/Projects/Alfredv1/src/types.ts)
- [sessionOutputs.ts](/Users/nikhil/Projects/Alfredv1/src/memory/sessionOutputs.ts)

## 12) Tool envelope

53. Specialist tools execute through normalized envelope handling.
54. The envelope handles:
   - input parse/repair
   - schema validation
   - approval checks
   - execution
   - tool-call persistence
55. Standardized tool trace events are emitted.

Code:

- [registry.ts](/Users/nikhil/Projects/Alfredv1/src/agent/tools/registry.ts)

## 13) Run completion and memory persistence

56. `executeRunCore` persists final run status and artifacts.
57. `ChatService.persistRunOutcome(...)` updates session working memory with:
   - last run
   - last completed run
   - recent turns
   - last artifacts
   - last outcome summary
   - recent outputs
   - thread/session summary
58. Completed runs can later be recovered into runtime session context as durable recent outputs.
59. API returns the run summary/outcome.

Code:

- [chatService.ts](/Users/nikhil/Projects/Alfredv1/src/services/chatService.ts)
- [sessionStore.ts](/Users/nikhil/Projects/Alfredv1/src/memory/sessionStore.ts)
- [runStore.ts](/Users/nikhil/Projects/Alfredv1/src/runs/runStore.ts)

## Event families

- `route`
- `session`
- `thought`
- `tool`
- `observe`
- `final`
- `approval`

## Current architecture summary

Alfred now has:

- a deterministic control shell
- model-owned turn interpretation
- session-scoped working memory with recent outputs
- recoverable prior-output context
- specialist loops with generic active-work state
- explicit writer readiness and output availability semantics

The major remaining architecture gap is still the same one tracked in [corebehaviour_refactor.md](/Users/nikhil/Projects/Alfredv1/docs/architecture/corebehaviour_refactor.md): too much residual heuristic ownership remains in some orchestrator and specialist setup helpers.
