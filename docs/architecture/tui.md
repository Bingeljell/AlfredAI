# Alfred terminal surface

Alfred owns conversations; Telegram, web, and terminal are surfaces attached to
them. Opening a conversation elsewhere must preserve its session ID, context,
model preferences, history, artifacts, and active work. Detaching never cancels.

## First release

- `pnpm alfred tui [--session ID] [--url URL]` connects to the existing gateway.
- Pick an existing conversation (including Telegram), or explicitly create one.
- Keyboard-driven transcript, multiline composer, tool details, artifacts,
  shared model commands, explicit cancellation, and automatic reconnect.
- Authenticated conversation SSE sends authoritative snapshots. Reconnect replaces
  state by run ID; it never retries a submitted message automatically.
- Snapshots refresh every 250ms and include the latest 100 runs, completed
  tool receipts, artifact paths, and the latest 50 web/terminal notifications.
  Codex assistant text streams as redacted cumulative previews, including after
  reconnect. Other provider runtimes currently publish their completed answer.
- Terminal turns carry `tui` provenance. Notification destinations stay separate
  from the selected conversation. `/newsession` creates a new conversation in the
  terminal without resetting a conversation still open in Telegram.

## Follow-up foundation

Generalize channel bindings and link principal identities before enabling
cross-surface scheduler ownership. Add durable admission/idempotency and an event
cursor for incremental replay. Replace channel-only
logs with canonical conversation history, paginate it, and make shared JSON
updates transactional. Shared JSON mutations are now serialized and file
replacement is atomic. Define consistent reset semantics across existing surfaces.

Today the model window is 10 turn pairs clipped to 1,200 characters per message;
full run history remains separate. Queued submissions may wait for the preceding
turn before acknowledgement. Server restarts mark interrupted ordinary runs
failed. Snapshot streaming observes state; it does not resume interrupted execution.

## Acceptance

Start in Telegram, attach from the terminal during execution, see the result,
continue there, and follow up in Telegram with the same session context. Verify
detach/reconnect, concurrent turns, explicit cancellation, terminal restoration,
and authentication without invoking a live model in automated tests.
