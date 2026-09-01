# Alfred ChatGPT Subscription Runtime — Implementation Plan

**Status:** Approved direction; implement incrementally after the capability gate

**Date:** 2026-09-01

**Official integration surface:** Codex App Server

**Supersedes:** `docs/architecture/codex_subscription_provider.md`

## Decision

Alfred will not call the undocumented ChatGPT backend at
`https://chatgpt.com/backend-api/codex/responses` and will not manage or reuse raw
ChatGPT access tokens.

ChatGPT subscription access will use the documented Codex App Server protocol.
App Server will manage ChatGPT authentication, token refresh, the model-facing
turn, model discovery, and authoritative subscription usage information.

Alfred remains the product harness. It owns:

- identity, system instructions, specialists, and user-facing behavior;
- session memory and the selection of context supplied to a turn;
- channels, scheduling, artifacts, run state, cancellation, and telemetry;
- the Alfred tool registry, allowlists, schemas, permissions, execution, and
  output scrubbing;
- provider/runtime selection and the user's logical model tiers.

For existing providers, Alfred's current agent loop continues to own the
model/tool iteration. For ChatGPT subscription turns, Codex App Server owns the
inner model turn and asks the client to execute tools. Alfred remains the only
executor of Alfred tools.

OpenAI does not document a raw, subscription-backed Responses endpoint for an
arbitrary low-level `LlmProvider`. Consequently, the supported integration is a
runtime adapter rather than a direct replacement transport inside the existing
provider interface.

## Hard capability gate

Do not begin the broad runtime refactor until a focused App Server spike proves
the following against the installed Codex version:

1. Alfred tools can be supplied as client-executed dynamic tools and invoked
   successfully through `item/tool/call`.
2. Unknown tools and malformed arguments can be rejected by Alfred.
3. Built-in Codex shell, filesystem, patch, browser, and network capabilities
   can be disabled, rejected, or sandboxed so that they cannot produce effects
   outside Alfred's tool policy.
4. An ephemeral thread can receive Alfred-selected prior message items, execute
   one turn, stream a final response, and be discarded.
5. Cancellation interrupts the active turn and cleans up pending tool calls.

Dynamic tools are a documented but experimental App Server facility. Treat
their protocol as capability-detected and isolate it behind one adapter. If the
built-in-tool boundary cannot be enforced, stop after the spike and document
the blocker. Do not silently weaken the ownership rule.

## Target architecture

```text
ChatService
    |
    v
AgentRuntime
    |
    +-- AlfredAgentRuntime
    |      existing agentLoop + LlmProvider
    |
    +-- CodexAppServerRuntime
           Alfred-selected context
           ephemeral Codex thread/turn
           Alfred dynamic tool definitions
           Alfred tool execution and policy
```

Introduce a provider-neutral `AgentRuntime` above `LlmProvider`:

```typescript
interface AgentRuntime {
  runTurn(request: AgentTurnRequest): Promise<AgentTurnResult>;
}
```

`AlfredAgentRuntime` wraps today's `agentLoop` without changing existing
providers. `CodexAppServerRuntime` translates an Alfred turn to App Server
requests and events. `ChatService` selects a runtime without knowing its
protocol details.

## Context ownership

Alfred's session store remains the only durable conversational source of truth.
Do not resume App Server threads as Alfred sessions and do not rely on Codex
compaction for Alfred memory.

For each ChatGPT subscription turn:

1. Alfred constructs its normal system instructions and selected context.
2. Start a fresh ephemeral App Server thread.
3. Inject the selected prior user and assistant items using
   `thread/inject_items`.
4. Start exactly one current user turn with `turn/start`.
5. Relay client-executed tool requests to Alfred's normal execution envelope.
6. Capture the final assistant response, usage, failures, and timing.
7. Persist those through Alfred's existing stores and discard the ephemeral
   App Server thread.

The current user message must appear exactly once. Add regression coverage for
duplicate context, stale replies, and accidental Codex-thread persistence.

## Authentication and credential ownership

Use App Server account methods:

- `account/read`;
- `account/login/start` with `type: "chatgpt"` for browser login;
- `account/login/start` with `type: "chatgptDeviceCode"` for remote/headless
  login;
- `account/login/cancel`;
- `account/logout`;
- `account/updated` and `account/login/completed` notifications.

Codex owns credential storage and refresh. Alfred must not read, return, log,
copy, or persist access and refresh tokens. Remove the separate
`~/.alfred/codex-auth.json` flow when the migration is complete.

## Login user experience

### Web UI — primary

Add **Settings → Models & Accounts → OpenAI / Codex**.

For a local installation:

1. The user selects **Sign in with ChatGPT**.
2. Alfred requests a browser login from App Server.
3. The UI opens the returned authorization URL.
4. The browser completes ChatGPT authentication and the local callback.
5. The UI observes completion and shows the plan and account state.

For a remote Alfred host, offer **Use device code** because a localhost callback
opened on another device will not reach the Alfred host. Display only the
official verification URL, one-time code, expiry, and cancellation control.

### Terminal — full administrative fallback

Preferred commands:

```bash
pnpm alfred auth login openai
pnpm alfred auth login openai --device-code
pnpm alfred auth status openai
pnpm alfred auth logout openai
```

Keep `pnpm codex:login`, `pnpm codex:status`, and `pnpm codex:logout` as
compatibility aliases during migration.

The terminal command prints only the App Server authorization URL or device
verification URL/code, waits for `account/login/completed`, and closes only
after success, failure, timeout, or cancellation. It defaults to ten minutes;
`--timeout-ms` changes that bound and Ctrl-C sends `account/login/cancel`.

### Telegram — controls only

Telegram does not perform account login. An allowlisted chat gets the same
ChatService `/help`, `/status`, `/model`, `/reasoning`, and `/usage` controls as
the Web UI; login remains in the terminal or Web UI so authorization details
are not sent through chat.

Telegram currently exposes the channel-independent `/help`, `/status`,
`/model`, `/reasoning`, and `/usage` controls. Login remains deliberately
outside Telegram.

## Model selection and reasoning

Do not hardcode the App Server model catalogue as the authority. Use:

- `model/list` for visible models, defaults, input modalities, and supported
  reasoning efforts;
- `modelProvider/capabilities/read` for model/provider capability bounds.

`ALFRED_MODEL_SMART` is the configured global/default model for Codex turns.
The current implementation provides per-session `/model` and `/reasoning`
overrides. It does not provide a per-turn override syntax. Validate model and
effort combinations against a fresh or short-lived `model/list` catalogue
before each turn. If a saved model disappears, show the live default fallback
explicitly; if its saved effort is invalid for the effective model, reset to
that model's `defaultReasoningEffort` and say so. Numbered choices are only
shortcuts for the list displayed by the current catalogue; they are never a
universal semantic mapping.

## Subscription usage and limits

Use App Server as the authoritative account source:

- `account/rateLimits/read` and `account/rateLimits/updated` for window usage,
  reset time, plan type, credits, and reached-limit classification;
- `account/usage/read` for account token-activity summaries and daily buckets.

Alfred keeps a redacted, short-lived rate-limit snapshot and applies
`account/rateLimits/updated` notifications immediately. A reached
`rateLimitReachedType` blocks a new Codex turn before `turn/start`; the user
message names the bucket and reset time when supplied. `/usage` reports this
subscription quota separately from Alfred's local per-run token totals.

Continue recording Alfred's per-run token counts and timings locally. Keep the
two concepts distinct:

- **run telemetry:** what a particular Alfred run consumed;
- **account quota:** what ChatGPT reports for the subscription account.

Show warnings before exhaustion, including reset time. Never switch providers,
models, or billing modes silently when a subscription limit is reached.

Changing `ALFRED_LLM_PROVIDER`, `ALFRED_MODEL_SMART`, or other `.env` settings
requires restarting Alfred. Existing sessions retain their explicit
session-scoped picker choices across a normal server restart; `/model default`
and `/reasoning default` clear those overrides, while `/newsession` starts with
the configured global defaults.

## Safe gateway surface

Suggested authenticated routes:

```text
GET    /v1/accounts/openai
POST   /v1/accounts/openai/login
POST   /v1/accounts/openai/login/device
GET    /v1/accounts/openai/login/:loginId
DELETE /v1/accounts/openai/login/:loginId
POST   /v1/accounts/openai/logout
GET    /v1/accounts/openai/models
GET    /v1/accounts/openai/usage
```

Responses may contain account state, plan type, login progress, authorization
or verification URLs, temporary device codes, models, reasoning capabilities,
quota percentage, and reset timestamps. They must never contain bearer tokens,
refresh tokens, raw credential files, or App Server environment values.

Apply Alfred gateway authentication, rate limiting, redaction, and no-store
response headers to all account endpoints.

## Incremental commit plan

Each meaningful commit must include relevant automated tests and one changelog
entry. Run `pnpm tsc --noEmit` after each code change and all relevant tests
before every commit. Use `scripts/committer`; do not add co-authors.

1. **`docs: redesign ChatGPT subscription integration around Codex App Server`**
   - Commit this decision document and its changelog entry.

2. **`test: validate Codex App Server tool and sandbox boundaries`**
   - Add a focused executable spike and protocol fixtures.
   - Prove the hard capability gate. Stop and report if it fails.

3. **`feat: add supervised Codex App Server client`**
   - Add process lifecycle, initialization, correlated RPC, notifications,
     server requests, interruption, crash handling, and protocol tests.

4. **`feat: manage ChatGPT sign-in through Codex App Server`**
   - Implement account state, browser and device-code login, cancellation,
     logout, and CLI compatibility aliases without token access.

5. **`feat: expose safe ChatGPT account management APIs`**
   - Add authenticated gateway routes, response redaction, no-store behavior,
     and API tests.

6. **`feat: add ChatGPT subscription controls to the web UI`**
   - Add login, device-code fallback, status, logout, and clear error states.

7. **`feat: discover Codex models reasoning and subscription limits`**
   - Add catalog, capability, quota, and usage services plus UI/API surfaces.

8. **`refactor: separate Alfred agent runtime from model providers`**
   - Add `AgentRuntime`; wrap the existing loop with no behavioral changes.

9. **`feat: execute Codex turns with Alfred tools`**
   - Add the App Server runtime, ephemeral context injection, dynamic tool
     dispatch through Alfred's execution envelope, cancellation, and end-to-end
     tests.

10. **`refactor: remove undocumented ChatGPT transport`**
    - Remove the private endpoint, custom OAuth/token persistence, private SSE
      implementation, obsolete fixtures, and obsolete configuration.

11. **`docs: document ChatGPT subscription setup and operations`**
    - Update README, `.env.example`, troubleshooting, model selection, context,
      usage-limit behavior, security notes, and migration guidance.

## Acceptance criteria

The migration is complete only when:

1. No production code calls an undocumented ChatGPT endpoint.
2. Browser and device-code subscription login work through App Server.
3. Alfred never reads or exposes ChatGPT tokens.
4. Model and reasoning choices come from the live App Server catalog.
5. Account quota and reset information are visible separately from run usage.
6. Existing non-Codex providers retain their current behavior.
7. Alfred remains the durable context source and current input is not duplicated.
8. Every externally effective tool action runs through Alfred's registry and
   policy envelope.
9. Cancellation, timeout, login failure, quota exhaustion, App Server crash,
   malformed tool arguments, and unavailable models have tested safe outcomes.
10. Type checking and all relevant automated tests pass.

## References

- OpenAI authentication documentation: <https://learn.chatgpt.com/docs/auth>
- Codex App Server protocol: <https://learn.chatgpt.com/docs/app-server>
- Codex models: <https://learn.chatgpt.com/docs/models>
- ChatGPT/Codex pricing and usage: <https://learn.chatgpt.com/docs/pricing>
