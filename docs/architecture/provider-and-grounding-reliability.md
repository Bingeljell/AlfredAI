# Provider, Browser, and Grounding Reliability

This note describes the runtime hardening added after Alfred produced stale and unsupported answers in long MiniMax/OpenRouter sessions. The fixes are provider-agnostic where possible; changing models is no longer the only mitigation.

## 1. Read-only browsing: Pinchtab first

`web_fetch`, `lead_extractor`, and `lead_generation` use `PreferredBrowserPool`:

1. If Pinchtab is configured and healthy, use it.
2. If Pinchtab is unhealthy, or a collection attempt returns no pages and failures, lazily start Playwright when `ALFRED_ENABLE_PLAYWRIGHT=true`.
3. After fallback, keep the same backend for the rest of that pool's lifetime.
4. If fallback is disabled, fail with an actionable error instead of pretending content was fetched.

This does not require Pinchtab to run in the SearXNG container. Alfred connects to `PINCHTAB_BASE_URL`, so Pinchtab may run as a host process or as a separately exposed service. When `PINCHTAB_START_CMD` is configured, Alfred supervises that process, captures startup diagnostics, and attempts at most three bounded restarts.

The interactive `browser_*` tools still use Playwright because they depend on persistent page state, element references, tabs, typing, and screenshots. The direct `pinchtab_fetch` and `pinchtab_search` tools are also available to the agent.

The provider status endpoint exposes the configured browser preference, Pinchtab health, and Playwright fallback state. `web_fetch` reports the backend it used and any fallback reason.

## 2. OpenRouter reasoning controls

OpenRouter requests support a deployment-wide default reasoning configuration:

| Variable | Accepted values | Meaning |
|---|---|---|
| `OPENROUTER_REASONING_ENABLED` | `auto`, `true`, `false` | Leave model behavior unchanged, explicitly enable, or explicitly disable reasoning |
| `OPENROUTER_REASONING_EFFORT` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Request an effort level on models that support it |
| `OPENROUTER_REASONING_MAX_TOKENS` | positive integer | Request a reasoning token budget instead of an effort level |
| `OPENROUTER_REASONING_EXCLUDE` | `true`, `false` | Ask OpenRouter not to include reasoning content in the response |

Effort and token budget are mutually exclusive. A configured effort or budget cannot be combined with `OPENROUTER_REASONING_ENABLED=false`; invalid combinations fail during startup configuration validation.

When reasoning is configured, the provider sends OpenRouter's `reasoning` request object and `provider.require_parameters=true`. This prevents silent routing to an upstream endpoint that does not accept the requested parameter. In `auto` mode with no other reasoning fields, Alfred omits the object and preserves the model/provider default.

Alfred also forwards the stable Alfred session ID for routing affinity, requests OpenRouter routing metadata, records bounded provider metadata in `llm_provider_metadata` run events, and accounts for returned reasoning tokens separately from ordinary completion tokens. `GET /v1/llm/status` reports the active reasoning configuration without exposing credentials.

This is capability negotiation, not a promise that every model will reason well. A model must support the requested setting, and reasoning depth does not replace evaluation of answer quality.

## 3. Action-claim grounding

The agent loop maintains an in-memory set of tools that completed successfully during the current run. Before releasing a final interactive reply, `groundingGuard.ts` checks high-confidence first-person completion claims against that evidence ledger.

Covered claim classes include:

- search and SearXNG use;
- page fetching and browsing;
- repository, source, and file reads;
- file/document/code writes and edits;
- command, build, test, commit, and push execution;
- interactive browser actions such as clicking, typing, submitting, and screenshots.

If a claim has no matching successful tool receipt:

1. Alfred logs a `grounding_violation` event containing the claim category, accepted evidence tools, and current successful-tool names.
2. The unsupported draft is withheld.
3. The model receives one correction pass: call the required tool, or answer honestly without the claim.
4. If the repaired draft repeats an unsupported claim, Alfred returns a deterministic correction instead.

Only successful current-run calls count. Conversation history is useful context, but it is not proof that Alfred performed an action now. Failed tool calls also do not count.

The guard deliberately does not attempt general factual verification. Source-grounded research still depends on the research pipeline (`search` then `web_fetch`) and on the model accurately synthesizing returned evidence. The runtime guard closes the narrower, high-confidence failure mode where Alfred says it used a tool that it never called successfully.

Scheduler-origin turns retain their separate deterministic terminal-action contract and do not use this interactive repair pass.

## 4. Session context boundary

These changes complement the session-context fix: completed conversation turns are replayed once as ordinary messages, summaries are not injected alongside the same window, and the current user request appears exactly once and last. That reduces stale-branch selection, while action grounding prevents a plausible-sounding reply from inventing work in the current run.
