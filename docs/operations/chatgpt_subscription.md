# ChatGPT subscription operations

Set `ALFRED_LLM_PROVIDER=codex`, install the Codex CLI, and restart Alfred
after changing `.env` provider or model settings.

## Login

Terminal login is the administrative path:

```bash
pnpm alfred auth login openai
pnpm alfred auth login openai --device-code
pnpm alfred auth status openai
pnpm alfred auth logout openai
```

Browser login prints an authorization URL. Device-code login prints the
official verification URL and one-time code. The command remains alive until
the App Server reports success or failure, cancels after ten minutes by
default, and sends `account/login/cancel` on Ctrl-C. Set `--timeout-ms <ms>`
for a different timeout. Only Codex stores and refreshes credentials; Alfred
does not print or persist tokens.

The Web UI provides the same browser and device-code flows under Settings →
Models & Accounts, opens browser authorization when available, polls login
completion, and has a cancel button. Use device code when the browser is on a
different machine from the Alfred host.

## Session controls

Telegram and the Web UI share the same `ChatService` controls:

```text
/model
/model page N
/model N | /model NAME
/model default
/reasoning
/reasoning N | /reasoning NAME
/reasoning default
/usage
/status
/help
```

`model/list` supplies the live picker-visible catalog, display names, defaults,
and each model's supported reasoning efforts. Six models are shown per page;
numbering is never a fixed semantic mapping. Names must match exactly or be an
unambiguous short alias. A session override is stored in typed session state,
not in summaries. `/model default` and `/reasoning default` clear the relevant
override. A new session starts from the configured global defaults.

At the start of every Codex turn Alfred validates the saved selection against a
short-lived live catalog. If a model disappeared, Alfred reports the fallback
to the live/default model. If its saved effort is no longer supported, Alfred
reports the reset to that model's default effort. There is no per-turn picker
syntax in this release.

## Usage limits

`account/rateLimits/read` is the authoritative initial quota snapshot and
`account/rateLimits/updated` updates the redacted short-lived cache. If the
server reports a reached limit, Alfred does not start `turn/start`; the reply
names the bucket and reset time when available. A limit failure returned during
a turn is surfaced as a subscription-limit error when the refreshed state says
the account is reached.

`/usage` shows subscription quota windows and reset state separately from
Alfred's local per-run/session token totals. The two values are not
interchangeable.

The App Server boundary remains mandatory: Codex threads are ephemeral and
read-only/no-network, and all externally effective actions are Alfred dynamic
tools executed through Alfred's registry and policy envelope.
