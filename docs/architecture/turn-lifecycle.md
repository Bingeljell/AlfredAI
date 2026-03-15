# Alfred Turn Lifecycle (Current Runtime)

This document describes Alfred's *actual* runtime flow in the codebase today.

Scope:
- Request enters via `POST /v1/chat/turn`
- Runs through thread/turn control plane
- Executes Alfred orchestrator loop
- Optionally delegates to specialist loops
- Persists run/events/session memory

## 1) Session and run entry

1. `ChatService.handleTurn` receives `{ sessionId, message, requestJob? }`.
2. Session existence is validated.
3. Special command check: if message is `/newsession`, working memory is reset and a synthetic completed run is written.
4. A `RunRecord` is created (`queued` when `requestJob=true`, otherwise `running`).
5. Route event is emitted (`route:queued` or `route:inline`).
6. Session working memory is updated with the new user turn and active objective.

Code:
- `src/services/chatService.ts`

## 2) Thread runtime (per-session op queue)

7. ChatService submits `TurnOp(type="UserInput")` to `ThreadRuntimeManager`.
8. `ThreadRuntime` serializes operations per session (single active turn per session).
9. Watcher events are emitted on queue/start/complete/fail:
   - `thread_op_queued`
   - `thread_op_started`
   - `thread_op_completed`
   - `thread_op_failed`

Code:
- `src/core/threadRuntime.ts`

## 3) Turn runtime (deterministic shell)

10. `TurnRuntime.dispatch(UserInput)` enters `running` state.
11. Emits `TurnStarted` with message preview.
12. Starts periodic `TurnProgress` heartbeat for turn lifecycle.
13. Calls `executeRunCore` (the business execution path).
14. On outcome:
   - success path -> `TurnComplete`
   - failed/cancelled -> `TurnAborted`
15. Clears active turn context and returns to `idle`.

Additional ops handled:
- `Cancel`/`Interrupt`: records cancellation request + `TurnAborted(cancel_requested)`.
- `Approve`/`Reject`: records approval events.
- `Shutdown`: moves runtime to `shutdown`.

Code:
- `src/core/turnRuntime.ts`

## 4) Run core + ReAct entry

16. `executeRunCore` marks run `running` and starts run-level `observe:heartbeat` every 30s.
17. Invokes `runReActLoop(sessionId, message, runId, options)`.
18. `runReActLoop` emits `session:loop_started`.
19. If session memory exists, emits `session_context_loaded` summary.
20. Appends daily user note.
21. Applies approval gate (`evaluateApprovalNeed`). If blocked, returns `needs_approval`.
22. Emits `thought:intent_identified` as `master_orchestration`.
23. Calls `runAlfredOrchestratorLoop(...)`.

Code:
- `src/services/chatService.ts`
- `src/core/runReActLoop.ts`

## 5) Alfred orchestrator loop

24. Resolves turn objective (current message vs short follow-up continuation from session context).
25. Discovers full runtime tool catalog and agent skill catalog.
26. Builds immutable `objectiveContract` for this turn.
27. Initializes Alfred state/scratchpad and emits:
   - `alfred_loop_started`
   - `alfred_objective_contract_created`
   - `alfred_turn_state_updated`
28. Detects turn mode and execution permission:
   - `turnMode`: `diagnostic` or `execute`
   - `executionPermission`: `execute` or `plan_only`
29. If diagnostic mode: reads run evidence and returns diagnostic response (no specialist execution).

Code:
- `src/core/runAlfredOrchestratorLoop.ts`

## 6) Planner iteration (Alfred)

30. For each iteration (bounded by time/iterations/planner/tool budgets):
31. Runs structured planner model with context:
   - objective contract
   - current turn state
   - tools/agents + tool contracts
   - recent observations
   - session context
32. Handles planner failure classes (`network|timeout|schema|policy_block`) with retry/backoff policy.
33. Applies execution-permission guardrail:
   - if `plan_only` and planner requested execution, rewrites to `respond` plan-only answer.
34. Emits `alfred_plan_created` (and possibly `alfred_plan_adjusted`).

Planner can output one action type:
- `respond`
- `delegate_agent`
- `call_tool`

Code:
- `src/core/runAlfredOrchestratorLoop.ts`
- `src/core/reliability.ts`

## 7) Respond path

35. If planner chooses `respond`, Alfred runs completion contract gate.
36. If gate passes, run completes with assistant response.
37. If gate fails, emits `alfred_completion_contract_blocked` and continues loop.

Code:
- `src/core/runAlfredOrchestratorLoop.ts`

## 8) Delegate agent path

38. Alfred validates target skill from runtime registry.
39. Emits `agent_delegated`.
40. Runs `runAgentLoop(skillName, ...)`.
41. Skill dispatch:
   - `lead_agent` -> `runLeadAgenticLoop`
   - `research_agent` -> `runSpecialistToolLoop`
   - `ops_agent` -> `runSpecialistToolLoop`
42. On completion, emits `agent_delegation_result` and updates turn state.
43. Runs completion evaluator; if sufficient, returns final response, otherwise loops.

Code:
- `src/core/runAgentLoop.ts`
- `src/agent/skills/registry.ts`
- `src/agent/skills/*.ts`
- `src/core/runAlfredOrchestratorLoop.ts`

## 9) Direct tool path

44. Alfred validates tool existence + approval requirement.
45. Parses `toolInputJson`, validates schema.
46. Executes tool, writes tool call record, updates state.
47. Runs completion evaluator; if sufficient, returns final response, otherwise loops.

Code:
- `src/core/runAlfredOrchestratorLoop.ts`

## 10) Specialist loop (research/ops runtime)

48. Specialist loop emits `specialist_loop_started` with available tools and contract.
49. Uses iterative plan -> act -> observe -> replan with budgets.
50. Tracks phase state:
   - `discovery`
   - `fetch`
   - `synthesis`
   - `persist`
   - `complete`
51. Applies runtime adjustments/guards (examples):
   - schema recovery
   - diagnostic thrash guard
   - evidence-readiness guard before drafting
   - writer retry budget guard
   - persist output-path injection
52. Emits `specialist_action_result`, `specialist_plan_adjusted`, and guard events.
53. Returns result/assistant summary/artifacts to Alfred.

Code:
- `src/core/runSpecialistToolLoop.ts`

## 11) Tool envelope (normalized execution)

54. Specialist tools execute via `executeToolWithEnvelope`.
55. Envelope stages:
   - parse/repair JSON input
   - schema validation
   - approval gate
   - execute tool
   - persist tool call
56. Emits standardized tool trace events:
   - `tool_action_started`
   - `tool_action_rejected`
   - `tool_action_completed`
   - `tool_action_failed`

Code:
- `src/agent/tools/registry.ts`

## 12) Persistence and completion

57. `executeRunCore` persists terminal run status (`completed|failed|cancelled|needs_approval`) and artifacts.
58. ChatService updates session working memory:
   - last run/completed run
   - recent turns
   - outcome summary
   - artifacts
59. Returns run summary to API caller.

Code:
- `src/services/chatService.ts`
- `src/memory/sessionStore.ts`
- `src/runs/runStore.ts`

## Event map (high level)

- `route`: queued/inline entry
- `session`: loop + thread + turn lifecycle events
- `thought`: planning/objective/turn-state events
- `tool`: tool execution traces
- `observe`: action results + heartbeat
- `final`: stop/fail/cancel/final-answer

## Notes vs Codex architecture

Alfred now has a deterministic control shell + agentic inner loop, similar to Codex in shape:
- explicit op runtime (`ThreadRuntime`/`TurnRuntime`)
- strict lifecycle events
- bounded iterative planning and tool/delegation

Differences from Codex today:
- no MCP bootstrap/prewarm transport stack at Codex depth
- simpler hook ecosystem
- specialist set is fixed (`lead/research/ops`) rather than broad dynamic task classes
