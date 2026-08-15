# Agent Event Webhook & Decoupled Notification Architecture

*Date: 2026-08-15*  
*Status: Proposed / Spec*

---

## 1. Context & Motivation

When Alfred orchestrates or monitors background sub-agents (e.g. Pi, Claude Code, Codex running in terminal managers like Herdr, tmux, or Zellij), tasks can take minutes or encounter interactive gates (e.g. permission approval `[y/N]`, sudo prompts, selection dialogs).

In a pure request–response architecture, Alfred is passive: Alfred only inspects agent states when a human turn arrives.
- **Polling** introduces latency and idle CPU waste.
- **Tight terminal coupling** (e.g. building Herdr-specific APIs directly into core agent loops) prevents reusability with other terminal managers or standalone agent processes.

We need a **push-based, decoupled event protocol** so external agents or terminal wrappers can instantly notify Alfred of status transitions and approval gates without tying Alfred to a single terminal technology.

---

## 2. Decoupled Protocol Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Event Producers (Decoupled)                                 │
│                                                             │
│  ┌───────────────┐   ┌────────────────┐   ┌──────────────┐  │
│  │ Herdr Hook /  │   │ tmux / Zellij  │   │ Standalone   │  │
│  │ watcher       │   │ wrapper script │   │ Agent Hook   │  │
│  └───────┬───────┘   └────────┬───────┘   └──────┬───────┘  │
└──────────┼────────────────────┼──────────────────┼──────────┘
           │                    │                  │
           ▼                    ▼                  ▼
     POST /api/events/agent (JSON Payload / Local Socket)
           │
┌──────────┼──────────────────────────────────────────────────┐
│ Alfred Daemon (Node.js / launchd)                           │
│                                                             │
│  ┌───────▼────────┐                                         │
│  │  Event Ingress │ (Validate payload, auth token)          │
│  └───────┬────────┘                                         │
│          ▼                                                  │
│  ┌─────────────────────────┐                                │
│  │ Agent Event Dispatcher  │                                │
│  │ - Route by eventType    │                                │
│  │ - Session context match │                                │
│  └───────┬─────────────────┘                                │
│          │                                                  │
│          ├──> needs_approval ──> Telegram Proactive Push    │
│          ├──> completed      ──> Session State / Telegram   │
│          └──> failed         ──> Diagnostic Log / Alert     │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. The Agent Event Contract

Alfred exposes a lightweight local HTTP endpoint (`POST /api/events/agent`) and/or a Unix domain socket (`/tmp/alfred.sock`).

### 3.1 Event Schema

```json
{
  "version": "1.0",
  "source": "herdr",
  "agentKind": "pi",
  "workspaceId": "w9",
  "paneId": "p2",
  "sessionId": "optional-parent-alfred-session-id",
  "eventType": "needs_approval",
  "timestamp": 1755271200000,
  "payload": {
    "promptText": "Allow command: git push origin main [y/n]?",
    "suggestedAction": "confirm",
    "cwd": "/Users/nikhilshahane/projects/AlfredAI",
    "details": "git push origin main"
  }
}
```

### 3.2 Event Types
- `needs_approval`: Agent is blocked on a permission gate or interactive input.
- `completed`: Agent finished its objective cleanly.
- `failed`: Agent terminated with an unhandled error or exit code != 0.
- `progress`: Optional milestone/progress report for long runs.

---

## 4. Alfred Ingress & Handling Logic

1. **Ingress (`src/server/agentEvents.ts` or route in existing server):**
   - Validates the incoming JSON schema using Zod.
   - Requires a shared local secret or loopback authentication (`127.0.0.1` / Unix socket).

2. **Dispatcher Actions:**
   - **`needs_approval`**: Formats an actionable alert and immediately sends a proactive push via Telegram Bot API to Nikhil:
     > *"🚨 **Approval Required in `w9:p2` (Pi / AlfredAI):**\n`Allow command: git push origin main [y/n]?`\n\nReply `/approve w9:p2` or `/reject w9:p2`."*
   - **`completed`**: Updates active job tracking store; notifies Telegram if task was marked for proactive ping.
   - **`failed`**: Emits an error summary event.

---

## 5. Terminal Adaptors (Decoupling Boundary)

The core Alfred code never depends on Herdr. Instead, lightweight adaptors send events to Alfred:

1. **Herdr Adaptor**: Herdr pane hook or lightweight watcher reporting agent state transitions.
2. **Tmux / Zellij Adaptor**: Script wrapper catching exit codes or terminal status hooks.
3. **Agent Native Hook**: Pi/Claude extension hooks that post directly on lifecycle events.

---

## 6. Implementation Plan

- **Phase 1 (Ingress)**: Create `src/server/routes/agentEvents.ts` and Zod schema. Expose `POST /api/events/agent`.
- **Phase 2 (Notification)**: Wire `AgentEventDispatcher` into the Telegram outbound service for instant push messages.
- **Phase 3 (Producer Hook)**: Create `scripts/notify-alfred.sh` (or Herdr hook) that agents/panes can invoke to publish lifecycle events.
