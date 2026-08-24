# RFC: Alfred Autonomous Wake, Reminders, and Background Supervision

**Status:** Proposed — implementation-ready after approval  
**Owner:** Alfred Runtime  
**Target:** Alfred gateway process and background execution runtime  
**Related:** `docs/plan-autonomous-wake-and-reminders.md`, `docs/architecture/agent_event_webhook_spec.md`  
**Supersedes:** `docs/features/autonomous_scheduler.md` (earlier draft; do not implement)

---

## 1. Decision summary

Alfred will gain a persistent scheduler that survives daemon restarts and supports
four deliberately separate task kinds:

1. **Reminder** — deliver stored text at a future time without invoking an LLM.
2. **Wake turn** — run a tightly bounded Alfred turn when reasoning is required.
3. **Watch** — perform a deterministic, read-only probe on an interval and invoke
   Alfred only when the observed state changes or requires judgment.
4. **Event subscription** — react to an existing agent event, such as Herdr agent
   completion or failure, without polling.

The scheduler runs inside Alfred's existing gateway daemon. It does not create a
second runner service. Scheduled work uses Alfred's existing global queue and
per-session `ThreadRuntime`, but it has a distinct execution profile, restricted
tool authority, isolated task memory, and explicit notification provenance.

The delivery guarantee is **at least once internally with best-effort duplicate
suppression at user boundaries**. Claims and runs may be recovered after a crash;
deterministic cycle IDs and notification delivery IDs suppress duplicate turns
and messages where the transport supports it.

---

## 2. Problem statement

Alfred is currently reactive. A user turn creates a run, executes a bounded
agent loop, persists the result into the session conversation window, and ends.
This is insufficient for:

- a reminder that must fire after the current process has restarted;
- supervising a delegated Pi, Claude, or Codex task until it finishes;
- checking a long-running local job without the user repeatedly prompting;
- notifying the user when an external agent emits completion, failure, or an
  approval request;
- resuming a bounded background objective without polluting the interactive
  conversation window.

The solution must not turn every timer tick into an LLM request. It must also not
grant an unattended scheduled prompt the same mutation authority as an
interactive, authenticated user turn.

---

## 3. Goals

- Persist reminders and supervision tasks across gateway restarts.
- Deliver ordinary reminders deterministically with zero LLM calls.
- Prefer existing agent events over polling for Herdr supervision.
- Run reasoning-based wakes through Alfred's normal provider abstraction while
  retaining Alfred's tools, identity, run telemetry, cancellation, and queueing.
- Serialize scheduled and interactive turns for the same session.
- Keep scheduler task history separate from the interactive conversation window.
- Derive notification destinations from authenticated channel provenance rather
  than model-supplied chat IDs.
- Bound token use, wake frequency, concurrency, retries, cycles, and lifetime.
- Make crash recovery, duplicate suppression, cancellation, and missed deadlines
  deterministic and testable with a fake clock.

## 4. Non-goals

Phase one does not provide:

- cron expressions, calendars, or recurring timezone rules;
- arbitrary code predicates supplied by the model;
- distributed scheduling across multiple Alfred hosts;
- exactly-once execution of arbitrary external side effects;
- unrestricted shell, filesystem mutation, browser mutation, or Herdr control in
  unattended background turns;
- per-user OAuth or a multi-tenant scheduler;
- a second launchd service or separate scheduler daemon;
- catch-up execution for every missed interval while Alfred was offline.

---

## 5. Existing architecture constraints

The design integrates with the code that exists today:

- `src/gateway/server.ts` owns process startup, signal handling, and shutdown.
- `src/gateway/app.ts` constructs `SessionStore`, `RunStore`, the global
  `InMemoryQueue`, `ChatService`, search dependencies, and agent-event routing.
- `ChatService` creates runs and submits user input through the per-session
  `ThreadRuntimeManager`.
- `ThreadRuntime` serializes operations for one session, while `InMemoryQueue`
  enforces global run concurrency.
- normal `ChatService.handleTurn()` persistence updates interactive working
  memory and the sliding conversation window;
- `AgentEventDispatcher` already receives `progress`, `completed`, `failed`, and
  `needs_approval` events;
- Telegram's adapter owns inbound polling, while the agent-event notifier is an
  outbound-only client configured for one alert destination;
- the existing JSON helper is not an atomic scheduler store and must not be used
  as the scheduler's read-modify-write primitive.

---

## 6. Task model

### 6.1 Common task schema

Every task is validated with Zod on creation and every read.

```typescript
type ScheduledTaskKind =
  | "reminder"
  | "wake_turn"
  | "watch"
  | "event_subscription";

type ScheduledTaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

interface ScheduledTaskV1 {
  version: 1;
  id: string;                       // server-generated UUID
  label?: string;                   // optional display label, not an identifier
  kind: ScheduledTaskKind;
  status: ScheduledTaskStatus;

  owner: {
    sessionId: string;
    principalId: string;            // authenticated principal, never model-chosen
    channelKey?: string;            // opaque channel route, e.g. telegram:<id>
  };

  createdByRunId: string;
  createdAt: string;
  updatedAt: string;
  dueAt: string;                    // canonical UTC ISO-8601 timestamp
  expiresAt?: string;

  intervalSeconds?: number;
  intervalMode?: "fixed_delay";     // phase one supports fixed delay only
  maxCycles: number;
  cycleCount: number;
  consecutiveFailures: number;

  instruction?: string;             // bounded task goal; max 1,000 characters
  reminderText?: string;            // bounded deterministic delivery text
  watch?: WatchDefinition;
  eventMatch?: AgentEventMatch;

  activeCycleId?: string;
  activeRunId?: string;
  claimOwner?: string;
  leaseExpiresAt?: string;

  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastErrorCode?: string;
  lastObservationDigest?: string;
  notificationDestination?: NotificationDestination;
}
```

Task IDs are generated by the store. A caller may provide a label, but may not
choose an ID or overwrite an existing task.

### 6.2 Notification destination

```typescript
interface NotificationDestination {
  channelKey: string;
  principalId: string;
}
```

The scheduling tool derives this from `ToolContext` request provenance. It never
accepts a raw Telegram chat ID or arbitrary destination from the model. A web-only
turn may omit a push destination; its task remains visible through scheduler and
run APIs.

### 6.3 Reminder

A reminder contains `reminderText` and a one-shot `dueAt`. When due, the engine
sends the stored text through `OutboundNotifier`, records the delivery result,
and completes the task. No LLM or Alfred tools are invoked.

### 6.4 Wake turn

A wake turn contains a bounded `instruction`. It creates a scheduler-origin run
and executes Alfred with the background execution profile defined below.

Wake turns are for work that genuinely requires reasoning. They are not the
default mechanism for reminders or simple status checks.

### 6.5 Watch

Phase-one watches use typed, deterministic definitions, not arbitrary code:

```typescript
type WatchDefinition =
  | {
      type: "herdr_agent";
      workspaceId: string;
      paneId: string;
      agentName?: string;
    }
  | {
      type: "run_status";
      runId: string;
    }
  | {
      type: "file_exists";
      relativePath: string;
    };
```

The probe returns a normalized status and digest. If the status is unchanged and
non-terminal, the engine reschedules without invoking an LLM. A terminal state
is notified deterministically when possible. Alfred is invoked only for an
explicit `instruction` that requests bounded interpretation of a changed state.

### 6.6 Event subscription

```typescript
interface AgentEventMatch {
  workspaceId?: string;
  paneId?: string;
  agentKind?: string;
  source?: string;
  eventTypes: Array<"progress" | "completed" | "failed" | "needs_approval">;
}
```

The existing `AgentEventDispatcher` offers validated events to the scheduler
after event persistence. A matching subscription may complete a watch, cancel a
polling fallback, send a deterministic notification, or enqueue one bounded wake
turn. Event payload text is observation data, not instructions.

---

## 7. Scheduling semantics

### 7.1 Time input

The public tool accepts exactly one of:

- `delaySeconds`; or
- `runAt`, an ISO-8601 timestamp that must include an offset or `Z`.

The store converts all values to UTC ISO-8601. Phase one does not accept ambiguous
local timestamps. The tool may include the user's timezone in its confirmation,
but scheduling is based on the canonical UTC instant.

### 7.2 Bounds

Defaults and hard limits:

| Limit | Default | Hard limit |
| --- | ---: | ---: |
| Minimum delay | 5 seconds | 5 seconds |
| Minimum interval | 60 seconds | 60 seconds |
| Maximum scheduling horizon | — | 365 days |
| Maximum task lifetime | 24 hours for watches | 30 days |
| Maximum cycles | 10 | 50 |
| Instruction length | — | 1,000 characters |
| Reminder text length | — | 4,000 characters |
| Active tasks per principal | — | 20 |
| Active tasks globally | — | 100 |
| Concurrent scheduler executions | 1 | 2 |
| Global LLM wake start rate | 1 per 30 seconds | fixed in phase one |

Configuration may lower these values but must not raise the hard limits without a
code change and test update.

### 7.3 Interval behavior

Intervals are fixed-delay in phase one. The next due time is calculated from the
completion time of the current cycle, preventing catch-up storms.

If Alfred was offline across multiple intervals, the task fires once after
startup and then resumes its fixed delay. It never replays every missed interval.

### 7.4 Cycle and retry accounting

- `cycleCount` increments once when a new logical cycle is durably created.
- A transient delivery or probe retry does not consume another cycle.
- Each cycle receives a deterministic `cycleId = <taskId>:<cycleNumber>`.
- A task completes when its objective reaches a terminal state.
- A task expires at `expiresAt` or after `maxCycles`, whichever comes first.
- Three consecutive transient failures use bounded exponential backoff; a fourth
  failure marks the task failed and notifies the owner when possible.

---

## 8. Persistence, claiming, and recovery

### 8.1 Store layout

```text
workspace/alfred/scheduler/
  tasks.json
  tasks.lock
  deliveries.json
  task-runs/
    <task-id>.jsonl
```

`tasks.json` is a versioned snapshot. `task-runs` is an append-only audit log of
cycle state transitions and safe summaries. OAuth tokens, API keys, raw HTTP
headers, and unsanitized external output are forbidden from all scheduler files.

### 8.2 Mutation protocol

Every task-store mutation must:

1. Acquire `tasks.lock` with exclusive creation (`open(..., "wx")`).
2. Record an owner UUID, PID, creation time, and expiry in the lock.
3. Treat a lock as stale only after validating its expiry and owner metadata.
4. Read and Zod-validate the current snapshot while holding the lock.
5. Apply one deterministic mutation.
6. Write a same-directory temporary file with mode `0600`.
7. Flush and close the temporary file.
8. Atomically rename it over `tasks.json`.
9. Best-effort `fsync` the containing directory where supported.
10. Remove the owned lock in `finally`.

Within the process, mutations also use a single promise queue so the scheduler
tick, tools, event dispatcher, and cancellation cannot race each other.

### 8.3 Claim protocol

Claiming and creating a cycle are one atomic mutation. A claim records:

- `activeCycleId`;
- `claimOwner`, a scheduler-instance UUID;
- `leaseExpiresAt`;
- incremented `cycleCount`; and
- status `claimed`.

The engine transitions the claim to `running` and records `activeRunId` before
submitting a wake turn. Long-running claims renew their lease every 30 seconds.
Queue wait time is therefore covered by the lease and cannot make the same cycle
eligible for a second claim.

### 8.4 Delivery and run idempotency

- A scheduler-origin run stores `schedulerTaskId` and `schedulerCycleId` in run
  metadata. Before creating a run, the engine checks for an existing run with the
  same cycle ID.
- A notification uses `deliveryId = <cycleId>:<purpose>`. The delivery ledger is
  written before and after sending. Recovery retries only unresolved deliveries.
- Since a crash can occur after an external send but before the success record,
  transports should use an idempotency facility when available. Otherwise a
  duplicate notification remains possible and is prefixed as a recovered update.

### 8.5 Startup recovery

At startup, before the scheduler begins ticking:

- validate the store and quarantine invalid tasks individually;
- reclaim expired `claimed` tasks that never received a run;
- reconcile `running` tasks with their `RunStore` record;
- preserve active queued/running runs rather than creating duplicates;
- finalize tasks whose run already completed;
- retry unresolved notification deliveries;
- expire tasks past their deadline or cycle cap;
- execute each overdue task at most once.

---

## 9. Execution architecture

### 9.1 Scheduler lifecycle

`SchedulerEngine` is constructed alongside `ChatService` and started from
`gateway/server.ts` after normal interrupted-run recovery. The engine uses one
timer for the next due task, capped to wake at least every 15 seconds for recovery
and event processing. It does not poll every task on every tick.

Shutdown order:

1. Stop accepting new claims.
2. Clear the next-due timer.
3. Stop lease renewal for tasks that have reached a durable recoverable state.
4. Request cancellation for active scheduler runs when the shutdown grace period
   is exhausted.
5. Flush scheduler logs and release owned locks.
6. Continue normal gateway shutdown.

### 9.2 Scheduler-origin turns

Add an explicit execution profile:

```typescript
interface TurnExecutionProfile {
  origin: "interactive" | "scheduler";
  maxIterations: number;
  maxToolCalls: number;
  maxDurationMs: number;
  toolAllowlist: string[];
  persistConversation: boolean;
  schedulerTaskId?: string;
  schedulerCycleId?: string;
}
```

The phase-one scheduler profile is:

```typescript
{
  origin: "scheduler",
  maxIterations: 5,
  maxToolCalls: 5,
  maxDurationMs: 60_000,
  toolAllowlist: SCHEDULER_TOOL_ALLOWLIST,
  persistConversation: false
}
```

`ChatService.handleScheduledTurn()` creates a normal `RunStore` record and
submits it through `ThreadRuntimeManager`, preserving global concurrency and
per-session serialization. It must not call the methods that update interactive
working memory or `conversationWindow`.

The scheduler framing is server-owned system content. The task instruction is a
bounded goal. External event, file, terminal, or pane output is enclosed as
observation data and is never concatenated into the system prompt.

### 9.3 Background tool authority

The initial scheduler allowlist contains only purpose-built read-only tools:

- `scheduler_task_complete`
- `scheduler_task_reschedule`
- `run_status`
- `file_exists`
- `herdr_status`

`herdr_status` must expose normalized status and bounded pane output without the
mutating actions currently bundled into `herdr_control`.

Shell execution, file writes/edits, process stopping, browser mutation, agent
prompting, key sending, pane splitting, and agent starting are forbidden in
phase-one scheduler turns. Expanding this authority requires a separate RFC for
persisted user authorization and approval handling.

---

## 10. Notification architecture

Add a destination-aware outbound interface shared by reminders, scheduler runs,
and agent events:

```typescript
interface OutboundNotifier {
  send(args: {
    destination: NotificationDestination;
    text: string;
    deliveryId: string;
  }): Promise<{ delivered: boolean; externalMessageId?: string }>;
}
```

Telegram routing validates that the destination principal is still allowed and
that the channel mapping belongs to that principal. Web UI tasks appear in the
session activity/run feed; push delivery for the web UI may be added later.

Failures to notify do not erase the completed task result. They create a retryable
delivery record and remain visible in task status.

---

## 11. Public tools

### `schedule_reminder`

Inputs:

- exactly one of `delaySeconds` or `runAt`;
- `text`;
- optional `label`.

The notification destination and owner are derived from context.

### `schedule_wake`

Inputs:

- exactly one of `delaySeconds` or `runAt`;
- `instruction`;
- optional `intervalSeconds`;
- optional `maxCycles`;
- optional `label`.

This tool cannot request a broader background tool allowlist.
A wake without `intervalSeconds` is one-shot and must have `maxCycles=1`.
Multiple cycles require an interval.

### `schedule_watch`

Inputs:

- typed `watch` definition;
- `intervalSeconds`;
- optional bounded interpretation instruction;
- optional `maxCycles`, expiry, and label.

For a Herdr watch, this tool creates an event-first subscription plus the typed
polling fallback as one logical task. The caller does not need to create two
tasks or coordinate their cancellation.

### `cancel_scheduled_task`

Accepts a server-generated task ID. It may cancel only a task owned by the current
principal. If the task has an active run, it requests cancellation through
`ChatService.requestRunCancellation()` before marking the task cancelled.

### `list_scheduled_tasks`

Lists only tasks owned by the current principal, with safe fields: ID, label,
kind, status, due time, cycle count, and last safe error code. Instructions,
observations, destinations, and other users' tasks are not returned.

The tool names are added to Alfred's allowlist. Scheduler-only completion and
rescheduling tools are not added to the interactive allowlist.

---

## 12. Security model

- Scheduling authority comes from an authenticated interactive turn.
- Ownership and notification routes are derived, never supplied by the model.
- List and cancel operations are owner-scoped.
- Scheduler turns have a smaller, read-only capability set.
- Persisted instructions are goals, not durable grants of arbitrary authority.
- External observations remain untrusted data even if produced by another agent.
- Task persistence passes through the same redaction policy as run persistence.
- Raw observation data is clipped, scrubbed, and stored only as a digest plus a
  short safe status summary.
- The engine enforces global and per-principal quotas mechanically.
- A task cannot schedule another task from a scheduler-origin run in phase one.
- Notification failures, malformed store data, and probe errors produce safe
  codes without persisting raw credentials or unbounded external text.

---

## 13. Observability

Each cycle records:

- task ID, cycle ID, owner session, kind, and origin;
- scheduled, claimed, started, and completed timestamps;
- queue delay and execution duration;
- normalized probe transition;
- run ID when an LLM turn occurs;
- token usage from the associated run;
- delivery status and retry count;
- terminal safe error code;
- whether the cycle was recovered after restart.

Recommended scheduler event names:

```text
scheduler_task_created
scheduler_task_claimed
scheduler_cycle_started
scheduler_probe_unchanged
scheduler_probe_changed
scheduler_wake_queued
scheduler_cycle_completed
scheduler_delivery_attempted
scheduler_delivery_completed
scheduler_task_cancelled
scheduler_task_expired
scheduler_task_failed
scheduler_cycle_recovered
```

---

## 14. Acceptance criteria

- A one-shot reminder survives restart and sends without an LLM call.
- A scheduled wake uses at most five iterations, five total tool calls, 60
  seconds, and only the scheduler tool allowlist.
- Scheduled work for a busy session queues behind the active interactive turn
  without duplicate claim or execution.
- Scheduler runs do not change interactive recent turns, summaries, outputs, or
  conversation-window entries.
- Cancellation stops a pending task and requests cancellation of an active run.
- A Herdr completion event completes the matching subscription and cancels its
  polling fallback.
- An unchanged watch reschedules without an LLM call.
- Restart recovery executes an overdue interval once rather than replaying every
  missed occurrence.
- Duplicate cycle and notification IDs suppress repeat work during recovery.
- One principal cannot list, cancel, or redirect another principal's task.
- Hostile observation text cannot invoke a tool outside the scheduler allowlist.
- Task and delivery files contain no seeded credential canaries.
- The scheduler starts and stops with the existing gateway lifecycle.

---

## 15. Rollout

1. Ship the engine disabled by default behind `ALFRED_SCHEDULER_ENABLED=false`.
2. Enable deterministic reminders locally and observe recovery/delivery logs.
3. Enable event subscriptions for Herdr completion and failure.
4. Enable read-only watches with no LLM interpretation.
5. Enable bounded wake turns after security and token-budget tests pass.
6. Keep arbitrary background mutation out of phase one.
