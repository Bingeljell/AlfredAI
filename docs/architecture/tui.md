# Alfred terminal surface

Alfred owns conversations; Telegram, web, and terminal are surfaces attached to
them. Opening a conversation elsewhere must preserve its session ID, context,
model preferences, history, artifacts, and active work. Detaching never cancels.

## First release

- `pnpm alfred tui [--session ID] [--url URL]` connects to the existing gateway.
- Pick an existing conversation (including Telegram), or explicitly create one.
- Keyboard-driven transcript, multiline composer, tool details, artifacts,
  shared model commands, explicit cancellation, and automatic reconnect.
- Ctrl-L loads older history. The `conversation_history` tool retrieves earlier
  work for Alfred from the same canonical session records, regardless of surface.
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

Bindings now live in the shared channel layer. `/attach-channel telegram:CHAT_ID`
points an already-known Telegram chat at the selected conversation.
`/link-telegram USER_ID` explicitly links an allowlisted Telegram account to the
API owner for task access within the same session; attaching alone does not.
Links can be removed with `DELETE /v1/identities/telegram/:userId`.
Existing task owners and notification destinations are preserved.

Queued turns now acknowledge durable request IDs
immediately and build their context at execution time. Add an event cursor for
incremental replay. Runs now provide canonical paginated conversation history;
channel logs remain delivery/audit records. Shared JSON mutations are serialized
and file replacement is atomic. New-conversation commands preserve prior context.

The model window is reconstructed from persisted turns within 24,000 characters;
older content is available through history retrieval. Server restarts mark interrupted ordinary runs
failed. Snapshot streaming observes state; it does not resume interrupted execution.

## Acceptance

Start in Telegram, attach from the terminal during execution, see the result,
continue there, and follow up in Telegram with the same session context. Verify
detach/reconnect, concurrent turns, explicit cancellation, terminal restoration,
and authentication without invoking a live model in automated tests.
