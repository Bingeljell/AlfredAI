# Feature Spec: Autonomous Loop & Wakeup Mechanism (Reminders / Auto-Checkins)

**Status:** Draft / Proposed  
**Author:** Alfred  
**Target:** Alfred Background Daemon & Tool Ecosystem  

---

## 1. Problem Statement

Alfred operates strictly on a **reactive request-response** lifecycle:
1. An external trigger arrives (user message via Telegram, Web UI, CLI).
2. The agent loop initializes, executes tool calls up to turn budget/timeouts, produces a final response, and completes the turn.
3. The Node process remains alive under `launchctl`, but the agent execution loop is completely dormant until the next inbound message.

### Core Consequence:
For asynchronous, long-running, or multi-step delegated tasks (e.g., supervising a subagent running in Herdr/Pi/Claude, polling a remote RunPod GPU training/inference job, waiting on scheduled scraping/monitoring jobs), Alfred cannot autonomously wake up to inspect progress, intervene on failures, or deliver proactive status updates. The user is forced to manually act as the polling trigger.

---

## 2. Proposed Architecture

The design consists of three decoupled components:
1. **Persistent Task / Timer Store** (SQLite / JSON state on disk)
2. **Autonomous Background Heartbeat / Scheduler** (Daemon tick loop inside Alfred server)
3. **Agent Tool Surface** (`schedule_checkin` / `schedule_reminder`)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                            ALFRED RUNNER DAEMON                                  │
│                                                                                  │
│  ┌─────────────────────────┐                 ┌────────────────────────────────┐  │
│  │   Active Agent Loop     │                 │   Autonomous Heartbeat Daemon  │  │
│  │   (Turns, Tool Calling) │                 │   (Timer / Event Loop Tick)    │  │
│  └────────────┬────────────┘                 └───────────────┬────────────────┘  │
│               │                                              │                   │
│               │ schedule_checkin(...)                        │ Polls due tasks   │
│               ▼                                              ▼                   │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │                       Persistent Scheduler Store                           │  │
│  │              (workspace/alfred/state/scheduled_tasks.json)                │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Details

### A. Persistent Scheduler Store
Stored under `workspace/alfred/state/scheduled_tasks.json` (or SQLite):
```typescript
interface ScheduledTask {
  id: string;                      // e.g. "task_01j9a8b..."
  sessionId: string;               // Target session to resume context
  channelKey: string;             // Origin channel (e.g. telegram:1234, web:main)
  triggerType: "timer" | "interval" | "condition";
  triggerAtMs: number;             // Epoch time when task is due
  intervalMs?: number;             // For recurring polls (with maxRetries)
  maxExecutions?: number;          // Default: 1
  executionCount: number;
  status: "pending" | "running" | "completed" | "cancelled" | "failed";
  prompt: string;                  // Synthetic user prompt to inject
  context: {
    targetPaneId?: string;         // e.g. "w9:p1" (if watching Herdr agent)
    runPodJobId?: string;
    description: string;
  };
}
```

### B. Daemon Heartbeat Loop (`src/scheduler/heartbeat.ts`)
- A background ticker running inside the Node server process (e.g., every 5–10 seconds).
- Inspects pending tasks where `triggerAtMs <= Date.now()`.
- Atomically locks task (`status = "running"`) to prevent duplicate executions.
- Injects a synthetic execution turn into `chatService.handleTurn(...)` using the target `sessionId` and `channelKey`.
- If the turn completes and the goal is not met (and intervals remain), reschedules next tick; otherwise marks `completed`.
- If user output is generated, routes delivery to the original channel (e.g., Telegram push notification).

### C. Agent Tool Definition (`schedule_checkin.tool.ts`)
Exposes self-scheduling to the LLM:
```typescript
{
  name: "schedule_checkin",
  description: "Schedule a future wake-up prompt for Alfred to autonomously check on long-running work, poll external agents/jobs, or send a reminder.",
  inputSchema: {
    delaySeconds: z.number().min(5).max(86400),
    prompt: z.string().describe("What Alfred should evaluate when awakened"),
    description: z.string().describe("Human-readable task label"),
    targetPaneId: z.string().optional().describe("Herdr pane ID if monitoring an agent"),
    isRecurring: z.boolean().default(false),
    intervalSeconds: z.number().optional(),
    maxRetries: z.number().default(5)
  }
}
```

---

## 4. Execution Flow Example: Delegating to a Sub-Agent

1. **User:** *"Alfred, spawn a Pi agent to write tests for auth and monitor it until finished."*
2. **Alfred:**
   - Calls `herdr_control(action="start_agent", agentKind="pi", cwd=...)` $\rightarrow$ receives `paneId: "w4:p1"`.
   - Sends initial task keys to Pi.
   - Calls `schedule_checkin(delaySeconds=120, targetPaneId="w4:p1", prompt="Capture pane w4:p1. If tests pass, notify user. If stuck/hung, attempt recovery. If still running, reschedule for 120s.")`.
   - Responds to User: *"Pi subagent started in workspace 4. I will autonomously check progress in 2 minutes."*
3. **Turn Ends** (Alfred reactive state closes).
4. **2 Minutes Later:**
   - Background scheduler ticks, claims task, wakes `chatService` with synthetic prompt.
   - Alfred executes `herdr_control(action="capture_pane", paneId="w4:p1")`.
   - Alfred sees Pi is still executing $\rightarrow$ calls `schedule_checkin` again or marks interval.
5. **On Completion:**
   - Alfred sees Pi exited 0 with all tests passing.
   - Scheduler marks task `completed`.
   - Alfred pushes summary to user via Telegram / UI.

---

## 5. Failure Modes & Safety Guarantees

1. **Infinite Loop Prevention:**
   - Mandatory `maxExecutions` / retry cap on interval tasks (hard limit: 20 ticks).
   - Exponential backoff option on repeated stagnant states.
2. **Process Restart Resilience:**
   - State persisted to disk on write; on daemon boot, missed/expired tasks are swept and evaluated immediately.
3. **Context Pollution Control:**
   - Wake-up turns must not bloat conversation window needlessly. If an autonomous tick detects "no change / still running", it can record state silently without pushing spam to the user channel until milestone/error/completion.
4. **Concurrency & Locking:**
   - Prevent overlapping check-ins for the same task if a previous run takes longer than the tick interval.
