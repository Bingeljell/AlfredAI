# Alfred Codex Subscription Provider

**Status:** Approved direction; implementation pending  
**Date:** 2026-08-17

## Decision

Alfred should support ChatGPT Plus/Pro access through a native `codex` LLM provider.
The provider will use the user’s Codex OAuth session and the lower-level Codex
Responses transport. It must not turn a ChatGPT subscription into an
`OPENAI_API_KEY`.

Alfred remains the harness:

- Alfred owns the system prompt, conversation window, model selection, tool
  schemas, ReAct/tool-calling loop, tool execution, memory, approvals,
  telemetry, and provider fallback.
- The Codex provider owns authentication, token refresh, request translation,
  response streaming/parsing, and conversion of model tool calls into Alfred’s
  provider-neutral `LlmToolCall` shape.
- A tool call returned by Codex is data for Alfred to execute. Codex does not
  receive authority to run Alfred’s tools directly.

This gives Alfred the model access of Codex while preserving the harness
features that make Alfred Alfred.

## Why the lower-level provider is the right boundary

The Codex App Server is a higher-level integration surface. It exposes a
JSON-RPC interface around Codex, including Codex-managed authentication,
conversation/history behavior, approvals, and streamed events. That is useful
when an application wants to embed the Codex agent itself.

Alfred already has an agent runtime and should not delegate that runtime to a
second agent loop. Using the lower-level Responses transport avoids two
competing authorities over:

- which tools are available;
- when a tool is called and how its result is interpreted;
- memory and conversation-window construction;
- approval and safety policy;
- retry, timeout, fallback, and telemetry behavior; and
- the final response contract exposed by Alfred’s channels.

The App Server can remain a future integration option for a separate
“run Codex as a specialist” mode. It is not the core provider boundary for
Alfred.

## Request flow

```text
User message
    |
    v
Alfred chatService / runReActLoop
    |
    v
Alfred agentLoop
  - builds system + conversation messages
  - supplies Alfred tool schemas
  - chooses fast/smart model
    |
    v
Codex provider
  - loads local OAuth credential
  - refreshes it when needed
  - sends Responses request to Codex backend
    |
    v
Codex model response
  - text deltas, or
  - function/tool call data
    |
    v
Alfred agentLoop executes the tool and sends the result back
    |
    `--> repeats until the model returns the final answer
```

The first implementation may buffer the streamed Codex response until the
provider returns. Provider-level streaming can be exposed to Alfred’s channel
adapters later without changing ownership of the agent loop.

## Authentication model

The login flow is OAuth for the ChatGPT/Codex subscription:

1. The user runs `pnpm codex:login`.
2. Alfred completes the browser or device-code OAuth flow with OpenAI.
3. Alfred stores the access token, refresh token, expiry, and Codex account ID
   in a local Alfred auth file.
4. Each provider request uses the current access token as a bearer credential.
5. Alfred refreshes the credential before expiry and persists the rotated token.

The bearer value is an OAuth access token, not a public OpenAI API key. It must
not be placed in `.env`, renamed to `OPENAI_API_KEY`, printed in diagnostics, or
sent to Alfred tools.

The target configuration is:

```dotenv
ALFRED_LLM_PROVIDER=codex
ALFRED_MODEL_FAST=<a Codex-compatible model id>
ALFRED_MODEL_SMART=<a Codex-compatible model id>
# Optional; otherwise use Alfred's default per-user auth location.
ALFRED_CODEX_AUTH_FILE=/path/to/alfred/auth.json
```

The default auth file should be user-local, created with restrictive directory
and file permissions, and separate from Alfred’s `.env` configuration.

## Provider contract

The provider adapts Alfred’s existing neutral interface:

| Alfred operation | Codex transport behavior |
| --- | --- |
| `generateText` | Send system/user context and return generated text. |
| `generateStructured` | Request JSON-schema output where supported and validate the returned JSON in Alfred. |
| `generateWithTools` | Send Alfred function definitions and return text plus zero or more function calls. |

Conversation translation must preserve the semantics of tool turns:

- Alfred assistant tool calls become Responses function-call items.
- Alfred tool results become Responses function-call-output items.
- System messages become the Responses `instructions` context.
- User and ordinary assistant messages remain conversational input.

The provider should use the Codex backend’s Responses endpoint and account
context, while keeping the endpoint and authentication details inside the
provider module. The rest of Alfred should only see `LlmProvider` types.

## What Alfred gets

- ChatGPT subscription billing and entitlement instead of API-key billing.
- User-selectable Codex-compatible models through Alfred’s existing fast/smart
  model settings.
- Native tool calling into Alfred’s existing tool registry.
- Existing Alfred memory, Herdr orchestration, browser tools, artifacts,
  channel adapters, retries, and diagnostics.
- A provider boundary that can later support additional subscription-backed
  transports without changing the agent loop.

## Comparison with Pi

Pi is the closest useful reference because it separates subscription login from
the model provider:

| Concern | Pi’s approach | Alfred’s intended approach |
| --- | --- | --- |
| Login | OAuth login from `/login`; ChatGPT Plus/Pro is exposed as an OpenAI Codex provider. | A dedicated `pnpm codex:login` command with browser/device flow. |
| Credential storage | Local OAuth credentials with automatic refresh. | Local Alfred auth file with automatic refresh and restrictive permissions. |
| Transport | `openai-codex` provider uses Codex’s Responses transport and backend URL. | A provider adapter using the same protocol boundary, isolated under `src/provider/`. |
| Agent loop | Pi runs its own agent loop. | Alfred keeps its existing `agentLoop.ts` and tool execution. |
| Tools | Pi translates tool definitions for the model and executes them in Pi. | Alfred translates definitions, executes calls, and owns the safety boundary. |
| Model selection | Pi’s Codex model catalog. | Alfred’s `ALFRED_MODEL_FAST` / `ALFRED_MODEL_SMART`, validated against the supported Codex catalog as it evolves. |

The important lesson is the provider/auth split, not copying Pi’s entire
runtime. Pi’s implementation is a practical compatibility reference; it is not
a guarantee that the private Codex backend surface will remain unchanged.

## Security and reliability requirements

1. Never accept or log the access token, refresh token, JWT payload, or full
   authorization header as diagnostic data.
2. Store credentials outside the repository and `.env`, with mode `0600` for
   the file and `0700` for its parent directory where supported.
3. Refresh proactively and retry a single request after an authentication
   failure, without retrying indefinitely.
4. Keep the account ID only where required to address the user’s Codex account;
   do not expose it to model prompts or tools.
5. Redact authorization and account headers from request/error telemetry.
6. Make the provider fail with an actionable login message when no credential
   exists: `Run pnpm codex:login`.
7. Preserve Alfred’s existing timeout, retry, failure classification, and
   fallback behavior around the provider.
8. Treat the Codex backend endpoint as a compatibility surface. Pin behavior
   behind one module, add mocked protocol tests, and make endpoint/header
   changes localized.

## Implementation slices

### Slice 1 — OAuth credential lifecycle

- Add a Codex credential type and local auth-file reader/writer.
- Implement browser and device-code login.
- Decode the account ID from the OAuth access-token claims.
- Refresh and persist credentials before expiry.

### Slice 2 — Responses transport

- Add request conversion for text, structured output, and tool calls.
- Add SSE parsing for output text and function-call argument events.
- Return Alfred’s existing diagnostics and usage shape.
- Keep all Codex-specific headers and endpoint construction in this module.

### Slice 3 — Alfred provider integration

- Add `CodexLlmProvider` implementing `LlmProvider`.
- Register `codex` (and, if needed, `openai-codex` as an alias).
- Add model/configuration entries without requiring `OPENAI_API_KEY`.
- Keep `agentLoop.ts` unchanged except for provider-neutral behavior that is
  genuinely required by Responses semantics.

### Slice 4 — Verification and operations

- Unit-test credential validation, refresh, request translation, SSE parsing,
  tool-call round trips, and auth failures with mocked fetch responses.
- Run the existing type-check and relevant provider/runtime tests.
- Perform one manual smoke test after the user completes `pnpm codex:login`.
- Document logout/revocation and how to switch back to API-key providers.

## Non-goals

- Converting a ChatGPT subscription into an `OPENAI_API_KEY`.
- Replacing Alfred’s tools with Codex App Server tools.
- Running a second hidden agent loop inside Alfred.
- Sending Alfred’s auth credentials to a proxy or third-party gateway.
- Treating the private Codex backend endpoint as a stable public API.

## References

- [OpenAI Codex App Server documentation](https://learn.chatgpt.com/docs/app-server) — the higher-level JSON-RPC integration surface and its authentication/history/approval responsibilities.
- [Pi provider documentation](https://pi.dev/docs/latest/providers) — OAuth subscription providers, `/login`, and local credential management.
- [Pi OpenAI Codex provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/openai-codex.ts) — provider registration and Codex model catalog.
- [Pi OpenAI Codex OAuth implementation](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-codex.ts) — browser/device OAuth, refresh, and account-ID handling.
- [Pi OpenAI Codex Responses implementation](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-codex-responses.ts) — request conversion and Codex Responses streaming behavior.
