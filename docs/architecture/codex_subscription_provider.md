# Codex subscription integration

**Status:** Superseded and retained as a migration pointer.

The former Alfred-owned Codex subscription provider used custom OAuth/token
storage and an undocumented ChatGPT Responses transport. That implementation
has been removed. Do not restore it or use this document as an implementation
specification.

The supported design is documented in
[`chatgpt_subscription_app_server.md`](./chatgpt_subscription_app_server.md).
It uses the installed Codex App Server for ChatGPT authentication, token
refresh, model/account APIs, and the model-facing turn. Alfred remains the
durable context source, policy envelope, and executor for every Alfred tool.

Operational entry points:

```bash
pnpm alfred auth login openai
pnpm alfred auth login openai --device-code
pnpm alfred auth status openai
pnpm alfred auth logout openai
pnpm codex:app-server-gate
```

Codex App Server turns must use ephemeral threads, empty environments and
runtime workspace roots, read-only/no-network sandbox settings, and
`approvalPolicy: "never"` because Alfred owns approvals. Any server request
other than an Alfred dynamic tool call is rejected. Account responses and
logs must remain token-free.
