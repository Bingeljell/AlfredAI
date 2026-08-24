# Multi-Calendar & Smart Reminders Specification

## 1. Objectives & Use Cases
1. **Natural Language Reminders & Multi-Channel Delivery:** User asks Alfred to set a reminder (e.g., "remind me at 4pm to follow up with vendor"). Alfred triggers notification delivery across configured active channels (Telegram, Web UI alerts / WebSocket notifications, or desktop notifications) without hard-binding exclusively to Telegram.
2. **Unified Multi-Calendar Integration (Google & Outlook):** Read, write, search, and list events across Google Calendar (personal) and Microsoft Outlook/Office 365 (work) seamlessly.
3. **Contextual / Proactive Memory Reminders:** Store future-facing temporal commitments in knowledge/memory, resurfacing them at the right time.
4. **OS Independence & Frictionless OAuth:** Zero reliance on macOS-only tooling (no AppleScript/EventKit). Frictionless browser-based OAuth authorization flow where user clicks a single link in Web UI or Telegram to authenticate, avoiding manual API key / token gymnastics.
5. **Configurable Timezone:** All relative and absolute date/time parsing must respect a user-configurable timezone (defaulting to `Asia/Kolkata` or user override via config/env).

---

## 2. Architecture Overview

```
                               ┌─────────────────────────────────────────┐
                               │           Alfred Natural Language       │
                               │        (Configurable IANA Timezone)     │
                               └───────────────────┬─────────────────────┘
                                                   │
                         ┌─────────────────────────┴─────────────────────────┐
                         ▼                                                   ▼
           ┌───────────────────────────┐                       ┌───────────────────────────┐
           │ Multi-Channel Reminders   │                       │ Unified Calendar Provider │
           │ (Telegram, WebUI, SSE/WS) │                       │ (Read, Write, Search, Sync│
           └───────────────────────────┘                       └─────────────┬─────────────┘
                                                                             │
                                                   ┌─────────────────────────┴─────────────────────────┐
                                                   ▼                                                   ▼
                                     ┌───────────────────────────┐                       ┌───────────────────────────┐
                                     │  Google Calendar Provider │                       │ Microsoft Graph Provider  │
                                     │  (OAuth2 Refresh Token)   │                       │ (OAuth2 / MSAL Token)     │
                                     └───────────────────────────┘                       └───────────────────────────┘
```

---

## 3. Core Components & Design

### A. Configuration & Timezone Support
- Add `ALFRED_TIMEZONE` to configuration schema (`src/config/env.ts` with default fallback to `Intl.DateTimeFormat().resolvedOptions().timeZone` or user setting e.g. `Asia/Kolkata`).
- Natural language date/time parsing (e.g., via `chrono-node` or date-fns-tz) must anchor all relative queries ("tomorrow at 9am", "in 45 mins", "next Tuesday") to the configured timezone.

### B. Frictionless OAuth & Token Management
- **Local OAuth Callback Server / Gateway Route:**
  - Standard routes under Alfred gateway (e.g., `GET /api/auth/google/start`, `GET /api/auth/google/callback`, `GET /api/auth/microsoft/start`, `GET /api/auth/microsoft/callback`).
  - When user requests calendar connection, Alfred generates a signed auth URL. User clicks link -> logs in on Google/Microsoft -> redirected to callback -> Alfred stores encrypted refresh token in `workspace/alfred/credentials/calendar.json`.
- **Automatic Token Refresh:** Token lifecycle managed transparently by the provider service without prompting user again.

### C. Unified Calendar Interface (`src/services/calendar/`)
Define a unified interface:
```typescript
export interface CalendarEvent {
  id: string;
  source: 'google' | 'microsoft';
  calendarId: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  location?: string;
  attendees?: string[];
  htmlLink?: string;
}

export interface ICalendarProvider {
  listEvents(start: Date, end: Date, calendarId?: string): Promise<CalendarEvent[]>;
  createEvent(event: Omit<CalendarEvent, 'id' | 'source'>): Promise<CalendarEvent>;
  updateEvent(id: string, updates: Partial<CalendarEvent>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<boolean>;
  searchEvents(query: string, start?: Date, end?: Date): Promise<CalendarEvent[]>;
}
```

### D. Multi-Channel Reminder Dispatcher
- Refactor reminder firing mechanism so it does not assume Telegram is the only sink:
  - Check delivery channel preference or broadcast to active interfaces:
    - **Telegram Bot:** If chat ID / bot token configured.
    - **Web UI:** Via WebSocket / SSE push notification event payload.
    - **System Notification (Optional):** Local notification sound / OS notification.

### E. Tools to Expose to Alfred (`src/tools/definitions/`)
1. `calendar_list_events`: Fetch agenda for today, tomorrow, or custom date range across accounts.
2. `calendar_create_event`: Create an event in Google, Outlook, or specified calendar.
3. `calendar_search_events`: Query meetings or appointments by keyword.
4. `schedule_reminder`: Updated to support multi-channel notifications and explicit timezone offsets.

---

## 4. Implementation Slices for Luna Max

> **Luna's second opinion (2026-08-24):** Direction is right, but don't implement the 4 phases as written. Reorder into 4 slices that de-risk provider-specific failures and validate the domain model before writes or a second provider.

1. **Slice 0: Contracts & Security** — Principal/account ownership, timezone semantics, OAuth state/PKCE, credential key management, delivery idempotency, event types. (Foundational — everything else depends on these contracts.)
2. **Slice 1: Scheduler-Backed Reminders** — Extend the existing durable scheduler + delivery ledger. Add timezone-aware parsing + one reliable notifier path first. Note: current Web delivery is file-backed activity, not SSE/WebSocket — live push should be a separate adapter.
3. **Slice 2: One Calendar Provider, Read-Only** — Google read/list/search first. Validate the domain model before writes or a second provider.
4. **Slice 3: Microsoft Graph + Writes** — Outlook, then create/update/delete with confirmation, optimistic concurrency, attendee-invite safeguards.

### Key changes from Luna's review
- **Merge timezone into the reminder slice** — not a standalone phase.
- **Split the OAuth/provider phase** — implementing Google + Microsoft together will obscure provider-specific failures.
- **`ICalendarProvider` is too thin**: `Date` can't represent all-day events or timezone offsets reliably — needs richer temporal typing (e.g. `{ date, tz }` or `ZonedDateTime`).
- **Defer live Web push** (SSE/WebSocket) to a separate adapter; don't conflate it with the file-backed activity log.
- **Validate the domain model on one provider before adding writes or a second provider.**
