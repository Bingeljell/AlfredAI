# Alfred Codex Subscription Provider — Implementation Specification

**Status:** Approved for implementation

**Date:** 2026-08-17

**Compatibility level:** Experimental private transport, intentionally matching Pi

**Target implementer:** Luna Max

## Executor instruction

Implement this specification as written. Do not replace the provider with Codex
App Server, the Codex SDK, a subprocess-driven Codex agent, or an OpenAI API-key
provider. Do not revisit the architecture during implementation unless a required
protocol operation demonstrably fails against the live Codex backend.

When implementation details are not repeated here, use the linked Pi source as
the protocol compatibility reference and adapt it to Alfred's existing types and
runtime. Do not copy Pi's agent loop, UI, session system, or tool executor.

## Required outcome

Add `codex` as another native Alfred `LlmProvider`, alongside `openai`, `gemini`,
`anthropic`, `openrouter`, `ollama`, and `lmstudio`.

The completed integration must allow this configuration:

```dotenv
ALFRED_LLM_PROVIDER=codex
ALFRED_MODEL_FAST=<Codex-compatible model id>
ALFRED_MODEL_SMART=<Codex-compatible model id>
# Optional. Defaults to ~/.alfred/codex-auth.json.
ALFRED_CODEX_AUTH_FILE=/absolute/path/to/codex-auth.json
```

After `pnpm codex:login`, Alfred must use the user's ChatGPT/Codex subscription
credential to call the lower-level Codex Responses transport. It must expose the
same Alfred tools, memory, prompts, channels, and run behavior used with every
other provider.

Completion means all of the following are true:

1. `pnpm codex:login`, `pnpm codex:status`, and `pnpm codex:logout` work.
2. `CodexLlmProvider` implements all three `LlmProvider` methods.
3. A Codex response can request an Alfred tool, Alfred executes it, and Codex
   receives the function result on the next model call.
4. Codex reasoning/continuation output required for the next tool round is
   preserved without exposing it to tools, Alfred-authored prompt text, logs,
   or channel output.
5. Missing, expired, invalid, and refresh-failed credentials return safe,
   actionable errors without leaking secrets.
6. Automated unit, security, integration, and type-check suites pass.
7. Existing providers continue to pass their current tests.

## Non-negotiable ownership boundary

Alfred remains the agent and the only harness.

Alfred owns:

- the Alfred identity and system prompt;
- conversation-window and memory construction;
- model selection through `ALFRED_MODEL_FAST` and `ALFRED_MODEL_SMART`;
- tool discovery, allowlisting, schemas, dispatch, execution, and output
  scrubbing;
- the ReAct/tool-calling loop and iteration limits;
- approval and safety policy;
- cancellation, timeout, retry, run status, telemetry, and channel delivery;
- artifacts and all Alfred session persistence.

The Codex provider owns only:

- ChatGPT/Codex OAuth login and refresh;
- secure credential loading and persistence;
- translation between Alfred messages and Codex Responses input items;
- construction of the private Codex request and headers;
- buffered parsing of the streamed response;
- conversion of response text, usage, function calls, and opaque continuation
  items into Alfred's provider-neutral result types.

A Codex function call is data returned to `agentLoop.ts`. The provider must never
execute an Alfred tool. Codex App Server built-in tools, Codex shell access,
Codex filesystem access, Codex approvals, and Codex-managed history must not be
introduced by this integration.

## Accepted compatibility constraint

This implementation intentionally uses the same private ChatGPT backend
compatibility surface as Pi:

```text
https://chatgpt.com/backend-api/codex/responses
```

This endpoint is not the public OpenAI Platform Responses API. ChatGPT OAuth
credentials must never be renamed to or passed as `OPENAI_API_KEY`.

OpenAI officially documents subscription sign-in, cached credentials, automatic
refresh, browser login, and device-code login for Codex clients. OpenAI's
documented application integration surfaces are App Server and the Codex SDK.
Those higher-level surfaces are deliberately not used here because they run or
wrap a Codex agent instead of acting as a low-level model provider.

The private endpoint, request headers, event variants, model catalog, and OAuth
client behavior may change. Keep every private compatibility detail inside the
Codex provider directory and cover it with protocol fixtures. A future backend
change should require edits in that directory rather than in Alfred's agent loop.

## Phase-one scope

Phase one is a single-operator, local Alfred installation. One configured Codex
credential is shared by all Alfred sessions in that process. Do not add per-chat
or per-Telegram-user OAuth in this implementation.

Phase one uses HTTP SSE only. Do not implement Pi's WebSocket continuation,
zstd request compression, deferred tools, grammar tools, service tiers, or live
channel streaming. Preserve the interface boundaries needed to add those later.

## Current Alfred integration points

Use these existing files as the integration boundary:

| File | Required change |
| --- | --- |
| `src/provider/types.ts` | Add cancellation, session identity, and provider-opaque continuation state. |
| `src/provider/registry.ts` | Construct `CodexLlmProvider` for `ALFRED_LLM_PROVIDER=codex`. |
| `src/provider/router.ts` | No new cross-provider tool-loop fallback. Preserve current text/structured behavior. |
| `src/runtime/agentLoop.ts` | Pass session ID and abort signal; preserve provider state across assistant tool-call turns. |
| `src/provider/gemini.ts` | Migrate existing Gemini raw parts to the generic provider-state field. |
| `src/config/env.ts` | Add `codex` and `ALFRED_CODEX_AUTH_FILE`. |
| `.env.example` | Document `codex` selection and the optional auth path. |
| `package.json` | Add login, status, and logout scripts. |
| `src/utils/redact.ts` | Recognize OAuth fields, JWTs, account headers, and bearer values. |
| `src/runs/runStore.ts` | Redact run/event data before persistence, not only during debug export. |
| `docs/changelog.md` | Describe the implementation in the same commit. |

## Required file layout

Create these files:

```text
src/provider/codex/
  auth.ts          # credential schema, secure file I/O, refresh, single-flight lock
  oauth.ts         # browser PKCE and device-code login flows
  messages.ts      # Alfred <-> Responses item and tool translation
  sse.ts           # streaming frame parser and response accumulator
  transport.ts     # endpoint, headers, request body, retries, diagnostics
  provider.ts      # CodexLlmProvider implementation
  types.ts         # Codex-private wire types only

scripts/
  codex-auth.ts    # login/status/logout CLI entry point

tests/fixtures/codex/
  text-response.sse
  tool-call-response.sse
  structured-response.sse
  incomplete-response.sse
  failed-response.sse

tests/unit/
  codexAuth.test.ts
  codexMessages.test.ts
  codexSse.test.ts
  codexTransport.test.ts
  codexProvider.test.ts

tests/integration/
  codexAgentLoop.test.ts
```

Do not put Codex-specific request types or credentials in generic runtime files.
Do not add an `openai-codex` alias in phase one; the canonical provider name is
`codex`.

## Provider-neutral type changes

Replace the current Gemini-only raw response escape hatch with one generic,
in-memory provider-state shape:

```typescript
export interface LlmProviderState {
  provider: string;
  data: unknown;
}
```

Apply it to the provider-neutral conversation/result types:

```typescript
export type LlmConversationMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: LlmToolCall[];
      providerState?: LlmProviderState;
    }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface LlmToolCallResult {
  // Keep all existing fields.
  providerState?: LlmProviderState;
}
```

Add one shared base request and have `LlmTextRequest` and `LlmToolCallRequest`
extend it; `LlmStructuredRequest` continues to extend `LlmTextRequest`:

```typescript
export interface LlmBaseRequest {
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  sessionId?: string;
  signal?: AbortSignal;
}
```

Update Gemini to emit and consume:

```typescript
{ provider: "gemini", data: <existing raw parts> }
```

Remove `_rawGeminiParts` and `rawAssistantParts` after all call sites and tests
have migrated. Do not add a Codex-specific raw field.

For Codex, `providerState.data` must contain the complete raw `response.output`
items needed to replay the assistant turn, including encrypted reasoning items,
assistant message items, function-call item IDs, and call IDs. It must not
contain the OAuth token, account ID, HTTP headers, or an entire HTTP response.

When translating a prior assistant message:

- if it has `{ provider: "codex" }` state, replay those stored output items
  verbatim and do not synthesize duplicate assistant/function-call items;
- otherwise synthesize Responses items from `content` and `toolCalls`;
- ignore state belonging to a different provider.

Provider state is transient conversation state. Do not place it in run events,
debug exports, channel messages, tool inputs, or normal session summaries.

## Agent-loop changes

Keep the loop and tool execution logic in `src/runtime/agentLoop.ts`.

Make only these behavioral changes:

1. Create one `AbortController` for each active provider request.
2. Start a non-overlapping 250 ms cancellation poll around the provider call;
   abort the controller when `isCancellationRequested()` becomes true.
3. Start a deadline timer for the remaining request budget and abort the same
   controller when it expires. Record distinct abort reasons for caller
   cancellation and deadline expiry. Clear both timers in `finally`.
4. Pass `sessionId` and `signal` to `provider.generateWithTools`.
5. Store `llmResult.providerState` on the appended assistant tool-call message.
6. Continue executing returned calls through `executeToolWithEnvelope` exactly
   as the loop does today.
7. Keep calls sequential in phase one; do not refactor parallel tool execution.
8. Treat `finishReason="length"`, refusal, incomplete, failed, and cancelled as
   non-success outcomes rather than the current unexpected-finish success path.
9. When the provider returns `failureCode="cancelled"`, re-check
   `isCancellationRequested()`: return run status `cancelled` for a caller
   cancellation and the existing timeout outcome for a deadline abort.

Do not add Codex conditionals to the loop. All protocol-specific mapping belongs
inside `src/provider/codex/`.

## Authentication specification

### Credential schema

Persist this versioned JSON shape:

```typescript
interface CodexCredentialFileV1 {
  version: 1;
  provider: "codex";
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  accountId: string;
}
```

Validate it with Zod on every read. An invalid file must produce the safe public
message:

```text
Codex login is invalid. Run pnpm codex:login.
```

Never include a credential value or raw file contents in the error.

### Auth path

Resolve the path in this order:

1. `ALFRED_CODEX_AUTH_FILE` when set;
2. `path.join(os.homedir(), ".alfred", "codex-auth.json")`.

Requirements:

- resolve to an absolute path;
- reject a path located inside the Alfred repository;
- reject an existing symlink for the auth file;
- create the parent directory with mode `0700` where supported;
- write the file with mode `0600` where supported;
- write to a same-directory temporary file, flush and close it, then atomically
  rename it over the target;
- best-effort `chmod` both directory and file after creation;
- never write credentials to `.env`, the repo, `workspace/alfred`, telemetry,
  stdout, or stderr.

### OAuth constants and behavior

Match Pi's Codex OAuth flow:

```text
client_id: app_EMoamEEZ73f0CkXaXp7hrann
authorization endpoint: https://auth.openai.com/oauth/authorize
token endpoint: https://auth.openai.com/oauth/token
browser redirect URI: http://localhost:1455/auth/callback
scope: openid profile email offline_access
device user-code endpoint: https://auth.openai.com/api/accounts/deviceauth/usercode
device token endpoint: https://auth.openai.com/api/accounts/deviceauth/token
device verification URL: https://auth.openai.com/codex/device
device redirect URI: https://auth.openai.com/deviceauth/callback
device timeout: 15 minutes
```

Browser login must:

1. Generate a cryptographically random OAuth state.
2. Generate a PKCE verifier and S256 challenge.
3. Add `id_token_add_organizations=true` and
   `codex_cli_simplified_flow=true` to the authorization URL.
4. Bind the callback server to `127.0.0.1` only on port `1455`.
5. Validate the callback path and exact state before exchanging the code.
6. Attempt to open the system browser. If that command fails, print only the
   authorization URL and continue waiting.
7. Time out and close the callback server cleanly.
8. Exchange the authorization code using
   `application/x-www-form-urlencoded`, the verifier, client ID, and redirect
   URI.

Device login must:

1. Request a user code using the client ID.
2. Print the verification URL and user code.
3. Poll at the server-provided interval.
4. Treat HTTP `403` and `404` as pending, matching Pi.
5. Stop on success, cancellation, terminal error, or the 15-minute deadline.
6. Exchange the returned authorization code and verifier at the token endpoint
   using the device redirect URI.

Both flows must require `access_token`, `refresh_token`, and `expires_in` from
the token response. Do not interpolate or stringify a token response into any
error. Decode the access-token payload only to extract:

```text
https://api.openai.com/auth.chatgpt_account_id
```

This decode is claim extraction, not signature validation. Reject a missing or
empty account ID. Never store the whole JWT payload separately.

### Refresh behavior

- Refresh when `expiresAtMs <= Date.now() + 5 minutes`.
- Use `grant_type=refresh_token`, the current refresh token, and the Codex client
  ID.
- Persist both newly returned tokens and the new expiry atomically.
- Deduplicate refreshes inside the process with one shared in-flight Promise.
- Add a lock file beside the auth file for cross-process refresh. Acquire it
  using exclusive creation, re-read credentials after acquiring it, and remove
  it in `finally`. Treat locks older than 30 seconds as stale.
- Retry a model request once after an HTTP `401` by forcing refresh. Never enter
  an authentication retry loop.
- On `invalid_grant`, missing refresh token, or a second `401`, return:

```text
Codex login expired. Run pnpm codex:login.
```

### CLI commands

Add these scripts:

```json
{
  "codex:login": "tsx scripts/codex-auth.ts login",
  "codex:status": "tsx scripts/codex-auth.ts status",
  "codex:logout": "tsx scripts/codex-auth.ts logout"
}
```

Supported usage:

```bash
pnpm codex:login
pnpm codex:login -- --device
pnpm codex:status
pnpm codex:logout
```

`login` defaults to browser PKCE. `--device` selects device-code login.
`status` prints login state, expiry time, and the last four characters of the
account ID; it must not print tokens or the rest of the account ID. `logout`
deletes only the resolved Alfred
Codex auth file and its stale lock/temp files. It must not modify `~/.codex` or
log the user out of Codex CLI.

## Codex Responses transport specification

### Endpoint

Use HTTP `POST`:

```text
https://chatgpt.com/backend-api/codex/responses
```

Keep the base URL and endpoint construction private to `transport.ts`. Do not
add an environment override in phase one.

### Headers

Send exactly these semantic headers:

```text
Authorization: Bearer <access token>
chatgpt-account-id: <account ID>
originator: alfred
User-Agent: AlfredAI/<package version>
OpenAI-Beta: responses=experimental
Accept: text/event-stream
Content-Type: application/json
session-id: <request ID>
x-client-request-id: <request ID>
```

Generate a fresh UUID request ID per HTTP attempt. Do not expose raw headers to
diagnostics. Diagnostics contain only provider name, failure code/class, HTTP
status, elapsed milliseconds, attempt count, soft/hard timeout values, usage,
and whether the soft timeout was exceeded.

### Request body

Base every request on this shape:

```typescript
{
  model: request.model,
  store: false,
  stream: true,
  instructions,
  input,
  text: { verbosity: "low" },
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: stablePromptCacheKey,
  tool_choice: "auto",
  parallel_tool_calls: true,
  tools
}
```

Rules:

- `model` is required after applying the provider default.
- Combine all system messages, in order, into `instructions`, separated by two
  newlines. Do not also put system messages in `input`.
- Derive `stablePromptCacheKey` from a SHA-256 hash of Alfred's `sessionId` so
  the raw session ID is not sent. Use a stable `alfred-<hex>` value no longer
  than 64 characters. Omit it when no session ID is available.
- Omit `tools` when the request has no tools.
- Keep `store=false`; Alfred owns history.
- Buffer the SSE stream into one provider result in phase one.
- Do not set `temperature` for Codex models.
- Do not add Codex built-in tools.

For `generateStructured`, merge this into `text`:

```typescript
format: {
  type: "json_schema",
  name: request.schemaName,
  schema: request.jsonSchema,
  strict: true
}
```

Parse the returned output text as JSON and validate it with the supplied Zod
validator. Return `json_parse_error` or `zod_validation_error` consistently with
Alfred's existing providers.

### Tool definitions

Translate every `LlmToolDef` to a Responses function tool:

```typescript
{
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  strict: null
}
```

Do not wrap it in the Chat Completions `{ function: ... }` shape.

### Conversation translation

Translate messages in their existing order.

Ordinary user message:

```typescript
{
  role: "user",
  content: [{ type: "input_text", text: message.content }]
}
```

Ordinary assistant text without Codex provider state:

```typescript
{
  role: "assistant",
  content: [{ type: "output_text", text: message.content }]
}
```

Assistant tool calls without Codex provider state become Responses
`function_call` items. Preserve the Alfred tool-call ID as `call_id`, name, and
JSON argument string.

Tool results become:

```typescript
{
  type: "function_call_output",
  call_id: message.toolCallId,
  output: message.content
}
```

For an assistant message with Codex provider state, replay the stored raw output
items instead of reconstructing that assistant turn. This is required to retain
response item IDs, call IDs, and encrypted reasoning across a tool round.

### SSE parsing

The parser must:

- read arbitrary byte chunks with streaming `TextDecoder` behavior;
- accept both LF and CRLF line endings;
- split events on blank lines;
- concatenate multiple `data:` lines with `\n`;
- ignore comments and non-`data:` fields;
- ignore empty data and `[DONE]`;
- parse JSON without logging the raw frame on failure;
- cancel and release the reader when aborted;
- fail if the stream ends without a terminal response event.

Accumulate at minimum:

- output text deltas;
- reasoning-summary deltas when present, but do not expose them as final text;
- function-call items and argument deltas;
- raw `response.output` items or equivalent item events for provider state;
- usage fields;
- terminal response status and error details.

Treat `error` and `response.failed` as failures. Accept `response.done` and
`response.completed` as completion variants. Parse `response.incomplete` but
return a non-success result. Unknown events must be ignored unless they are
required to finish an already-started output item.

### Result mapping

Map Codex output to Alfred as follows:

| Codex outcome | Alfred result |
| --- | --- |
| Completed with text and no calls | `content`, `finishReason="stop"`. |
| Completed with one or more function calls | `toolCalls`, optional `content`, `finishReason="tool_calls"`. |
| Incomplete because of token/output limit | `failureCode="length"`, non-success. |
| Refusal | `failureCode="policy_block"`, `failureClass="policy_block"`. |
| Cancelled/aborted | `failureCode="cancelled"`; use `failureClass="timeout"` for deadline expiry and `failureClass="unknown"` for caller cancellation. The agent loop maps caller cancellation to run status `cancelled`. |
| HTTP 401 after refresh | `failureCode="codex_login_expired"`, `failureClass="policy_block"`. |
| HTTP 429 usage limit | `failureCode="rate_limit"`; do not retry terminal subscription-limit messages. |
| Retryable network/5xx exhaustion | existing network/timeout failure classes. |
| Malformed SSE or missing terminal event | `failureCode="protocol_error"`, `failureClass="unknown"`. |

Extract tool-call IDs from `call_id`, not the Responses output-item `id`.
Return the complete safe raw output items as:

```typescript
{
  provider: "codex",
  data: { outputItems: [...] }
}
```

Map usage:

```text
input_tokens                         -> promptTokens
output_tokens                        -> completionTokens
total_tokens                         -> totalTokens
input_tokens_details.cached_tokens   -> cachedTokens
```

Do not estimate subscription cost or treat token counts as API billing.

## Retry, timeout, and cancellation rules

Use Alfred's request `timeoutMs`, `maxAttempts`, run deadline, and `AbortSignal`.

- Abort applies to login, refresh, fetch, stream reading, and retry delays.
- Retry transient connection errors and HTTP `429`, `500`, `502`, `503`, and
  `504` only before any SSE event has been accepted.
- Respect `retry-after-ms` and `retry-after`, capped by the remaining deadline.
- Do not retry a terminal subscription-usage-limit response.
- Do not retry malformed protocol data.
- Do not retry after output text or a tool call has begun streaming.
- Authentication refresh plus resend is separate from `maxAttempts` and is
  allowed once.
- Never execute a tool twice because of a transport retry.

## Provider implementation

`CodexLlmProvider` must have this construction boundary:

```typescript
interface CodexLlmProviderOptions {
  authFilePath?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}
```

`fetchImpl` exists for deterministic tests. Do not expose credentials through
constructor options.

Each public method must:

1. Resolve the requested/default model or return a safe missing-model failure.
2. Load and refresh credentials through the shared credential manager.
3. Build its request through the same transport and translation layer.
4. Return Alfred's existing diagnostics and usage shape.
5. Never throw for an expected provider/auth/protocol failure; return a typed
   result. Programmer errors may still throw.

The provider name is exactly `codex`.

## Registry and configuration changes

In `src/config/env.ts`:

- add `codex` to `ALFRED_LLM_PROVIDER`;
- add optional `ALFRED_CODEX_AUTH_FILE`;
- expose it as `appConfig.codexAuthFile`;
- leave existing provider defaults unchanged.

In `src/provider/registry.ts`:

- add an explicit `case "codex"`;
- construct `CodexLlmProvider` with the configured auth path and
  `appConfig.modelSmart`;
- do not require `OPENAI_API_KEY`;
- do not silently fall through to `OpenAiLlmProvider`.

Do not redesign Alfred's existing fast/smart routing in this change. Codex must
honor `request.model` when supplied and otherwise use its configured smart-model
default, matching the other providers.

In `.env.example`, add `codex` to the provider list and document that Codex uses
`pnpm codex:login`, not `OPENAI_API_KEY`. Require the operator to set compatible
fast and smart model IDs when selecting Codex.

Do not claim automatic cross-provider fallback for the main agent loop. Alfred's
current tool loop uses one active provider. Switching providers remains an
operator configuration change followed by restart.

## Security hardening required in the same implementation

The OAuth provider cannot be considered complete unless Alfred's persistence
boundary is hardened.

1. Extend secret-key redaction to cover `accessToken`, `refreshToken`,
   `access_token`, `refresh_token`, `id_token`, `authorization`, `bearer`,
   `chatgpt-account-id`, and `accountId` when attached to auth diagnostics.
2. Recognize JWTs embedded inside prose, not only strings consisting entirely
   of a token.
3. Redact every `RunEvent` before `RunStore` writes it to storage or publishes
   it to subscribers.
4. Redact sensitive fields before `RunStore.updateRun` persists them.
5. Provider public failure messages must be constructed from safe enums and
   status codes, not raw upstream bodies or thrown-object serialization.
6. Never expose raw provider errors through `assistantText`.
7. Tests must seed unique canary access tokens, refresh tokens, account IDs,
   authorization headers, and token-response bodies, then assert the canaries
   are absent from stored run files, events, debug exports, and returned text.

Do not weaken existing output scrubbing or file-read restrictions.

## Required automated tests

### Auth tests

- valid credential read;
- invalid schema and truncated JSON;
- missing credential actionable error;
- repository-local path rejection;
- symlink rejection;
- `0700` directory and `0600` file modes where supported;
- atomic rewrite leaves a valid old or new file, never partial JSON;
- proactive refresh threshold;
- rotated refresh-token persistence;
- concurrent calls perform one in-process refresh;
- lock acquisition, stale-lock recovery, and re-read after lock;
- one forced refresh after 401 and no second auth retry;
- browser state mismatch rejection;
- browser callback timeout and cleanup;
- device pending, success, terminal failure, expiry, and cancellation;
- token-response errors never include token values.

### Message tests

- multiple system messages become ordered instructions only;
- user/assistant text mapping;
- tool definition mapping uses Responses shape;
- assistant function calls and tool outputs preserve `call_id`;
- Codex provider state replays raw items without duplication;
- other-provider state is ignored;
- structured-output format construction;
- stable hashed prompt-cache key.

### SSE tests

- frames split across every possible chunk boundary;
- multiple events in one chunk;
- LF and CRLF;
- multiple `data:` lines;
- comments and `[DONE]`;
- text accumulation;
- multiple parallel function calls with interleaved argument deltas;
- complete raw output items preserved as provider state;
- usage parsing including cached tokens;
- `response.done`, `response.completed`, and `response.incomplete`;
- error and failed events;
- invalid JSON without raw-frame leakage;
- stream ends without terminal event;
- abort cancels the reader.

### Transport/provider tests

- exact endpoint, method, required semantic headers, and body;
- no API key requirement;
- no OAuth/account values in diagnostics;
- successful text result;
- successful structured result and Zod rejection;
- successful tool-call result;
- retryable failure before stream start;
- no retry after stream start;
- Retry-After handling;
- terminal usage limit does not retry;
- 401 refresh and one resend;
- second 401 returns login-expired error;
- timeout and caller cancellation.

### Agent-loop integration test

Use a mocked Codex provider/transport to prove this exact sequence:

1. Alfred sends system, user context, and Alfred tool definitions.
2. Codex returns a function call plus Codex provider state.
3. Alfred executes the mocked Alfred tool once.
4. Alfred sends a function-call-output item and replays the prior raw Codex
   output items.
5. Codex returns final text.
6. Alfred completes with that text and records usage without provider state or
   secrets in run events.

## Implementation plan

Execute these steps in order. Do not begin the next step while the current
step's focused tests fail.

### Step 1 — Provider-neutral runtime support

- Add `LlmProviderState`, `sessionId`, and `signal` to provider types.
- Migrate Gemini raw parts to generic provider state.
- Update `agentLoop.ts` to preserve state and pass session/cancellation.
- Add regression tests proving Gemini and existing provider behavior remains
  intact.

**Gate:** `pnpm tsc --noEmit` and affected unit tests pass.

### Step 2 — Credential storage and OAuth

- Implement credential schema, path resolution, permission checks, atomic I/O,
  refresh locking, PKCE login, device login, refresh, status, and logout.
- Add package scripts and auth tests.

**Gate:** all `codexAuth` tests and security canary tests pass; no live login is
required for this gate.

### Step 3 — Message conversion and SSE parser

- Implement request-item/tool conversion and opaque state replay.
- Implement the buffered SSE parser and all protocol fixtures.

**Gate:** all message and SSE fixture tests pass.

### Step 4 — Transport and provider

- Implement exact endpoint/header/body behavior, safe diagnostics, retries,
  usage, structured output, and all three provider methods.
- Add transport and provider tests with injected `fetchImpl`.

**Gate:** all Codex unit tests pass without network access.

### Step 5 — Registry, configuration, and runtime integration

- Register `codex` and document environment configuration.
- Add the mocked agent-loop tool round-trip integration test.
- Verify writer/extractor tool-internal calls receive Codex through
  `context.llmProviders` without needing `OPENAI_API_KEY`.

**Gate:** type-check, unit, integration, and security suites pass.

### Step 6 — Documentation and manual smoke test

- Update README provider tables and setup instructions.
- Add implementation details to `docs/changelog.md`.
- Run `pnpm codex:login` with the operator.
- Smoke-test plain text, one Alfred tool call, one structured tool-internal call,
  refresh/status behavior, and switch-back to another provider.
- Run `pnpm codex:logout` only if the operator asks to remove the credential.

**Gate:** automated suites pass. Manual login/smoke testing is user-dependent
and must be reported separately if it cannot be completed unattended.

## Required verification commands

Run after implementation:

```bash
pnpm tsc --noEmit
pnpm test:unit
pnpm test:integration
pnpm test:security
```

Run any new focused tests directly during development. Do not make live Codex
network calls in automated tests.

## Final handoff checklist

- [ ] `codex` is a real `LlmProvider`, not an App Server/SDK wrapper.
- [ ] Alfred remains the only tool loop and executor.
- [ ] ChatGPT OAuth credentials are never treated as API keys.
- [ ] Login, status, logout, proactive refresh, and one-time 401 refresh work.
- [ ] Auth storage is outside the repo, atomic, permission-restricted, and
      concurrency-safe.
- [ ] SSE text, tool calls, usage, failures, and incomplete responses parse.
- [ ] Raw Codex output items survive tool rounds through generic provider state.
- [ ] Cancellation reaches active fetch/stream/refresh operations.
- [ ] No secret or provider state reaches telemetry, storage, tools, or users.
- [ ] Existing providers still work.
- [ ] README, `.env.example`, tests, and changelog are updated.
- [ ] All required verification commands pass.
- [ ] No push is performed unless explicitly requested.

## Non-goals

- Converting a ChatGPT subscription into `OPENAI_API_KEY`.
- Calling the public Platform API with an OAuth bearer token.
- Using Codex App Server, Codex SDK, Codex CLI subprocess execution, or Codex
  MCP server as Alfred's primary model provider.
- Allowing Codex to execute built-in shell, filesystem, browser, or MCP tools.
- Replacing Alfred's identity, memory, approvals, telemetry, channels, or agent
  loop.
- Multi-user OAuth or per-session Codex accounts.
- WebSocket transport, zstd compression, live token streaming, service tiers,
  deferred tools, grammar tools, or dynamic model-catalog discovery.
- Cross-provider fallback in the middle of a tool-calling conversation.
- Treating the private endpoint as a stable public OpenAI API.

## References

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth) — official
  browser/device login, automatic refresh, credential caching, and logout
  behavior for Codex clients.
- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server) — official
  higher-level integration deliberately excluded from this provider.
- [OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) — official
  programmatic Codex-agent integration deliberately excluded from this provider.
- [Pi provider documentation](https://pi.dev/docs/latest/providers) — subscription
  provider behavior and operator login model.
- [Pi OpenAI Codex provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/openai-codex.ts) — provider registration and private backend base URL.
- [Pi OpenAI Codex OAuth](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-codex.ts) — OAuth constants, PKCE, browser/device flows, refresh, and account-ID extraction.
- [Pi OpenAI Codex Responses](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-codex-responses.ts) — request body, headers, private endpoint, streaming, retries, and continuation behavior.
