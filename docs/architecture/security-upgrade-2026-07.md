# Alfred Security Upgrade — July 2026

*Written 2026-07-06. Turns the [security philosophy](./security-philosophy.md) and a full read-only audit into a prioritized, actionable plan. The philosophy doc is the **why** (values, provenance, capability grants); this is the **how** and the **in-what-order**.*

---

## The one shape behind every finding

A read-only audit of the repo surfaced ~20 findings across Critical → Low. Almost every serious one is the same shape:

> **untrusted content → the LLM → a powerful host-level tool**

Alfred ingests arbitrary web pages (`web_fetch`, `lead_extractor`, `fetch_tweet`) and feeds that text to the model. If a page carries a prompt-injection payload, it can steer the model into a privileged action — `shell_exec`, a shell-interpolated `save_link`, a filesystem write. The threat model is **prompt injection → tool execution**, not classic web bugs.

Two consequences shape the whole plan:

1. **You can't fix this by making the model refuse harder.** The injection targets the model you'd be trusting.
2. **You can't fix it by prompting the human on every step.** That kills the "mostly autonomous" goal.

So the strategy, consistent with the March philosophy, is: **stop trusting the input, bound the environment, and downgrade privilege based on data provenance — reserving human confirmation only for irreversible, outward-facing, or out-of-jail actions.**

---

## Audit findings (reference)

| ID | Sev | Finding | Fixed in phase |
|----|-----|---------|----------------|
| C1 | Critical | `shell_exec` on by default (`ALFRED_ENV=dev` ⇒ `trusted`), gated only by a bypassable denylist | 0 (posture) + 2 (taint) |
| C2 | Critical | Command injection in `save_link` — URL string-interpolated into `grep` via shell `exec` | 0 |
| C3 | Critical | Telegram bot serves everyone when `TELEGRAM_ALLOWED_USER_IDS` is empty (the default) | 0 |
| H1 | High | Secret-file denylist is basename-only, `file_read`-only; `shell_exec`/globs bypass it | 1 (jail) |
| H2 | High | No session-ownership check on `/v1/runs/:runId*` (IDOR); no rate limit; non-constant-time key compare | 0 |
| H3 | High | `code_discover` compiles user/model-supplied patterns to `RegExp` → ReDoS stalls the single process | 0 |
| H4 | High | Unrestricted SSRF — `web_fetch`/`lead_extractor` can hit `169.254.169.254`, localhost, RFC-1918 | 1 (egress filter) |
| M1 | Med | `.env` auto-mutated at runtime; generated key printed to logs | 0 |
| M2 | Med | Gemini key name mismatch: code reads `GOOGLE_GEMINI_API_KEY`, `.env.example` ships `GEMINI_API_KEY` | 0 |
| M3 | Med | Artifact path base mismatch (project-relative stored vs `workspaceDir`-joined on delivery) | 0 |
| M4 | Med | `RunStore.listRuns` full-scans all run files per poll (UI 4s / Telegram 3s) | later |
| M5 | Med | Blocking fs walks / `qmd` shell-out inside request path on single process | later |
| M6 | Med | Telegram legacy `parse_mode: "Markdown"` frequently falls back to plain text | later |
| M7 | Med | `onError` returns raw `error.message` to clients | 0 |
| L1 | Low | Two divergent redaction impls (`utils/redact.ts` weaker than `tools/outputScrubber.ts`) | 0 |
| L2 | Low | `context: any` / `as any` in lead + twitter tools despite `strict: true` | later |
| L3 | Low | UI renders agent-influenced markdown with no sanitizer (DOMPurify) → local XSS surface | 0 |
| L4 | Low | `save_link` writes YAML frontmatter by string interpolation → corruptible | later |
| L5 | Low | `.DS_Store` committed/present; only root-ignored | 0 |
| L6 | Low | `shell_exec` `.env` denylist is security theater given C1/H1 | 1 (retire w/ jail) |

---

## Priority & sequencing

### Phase 0 — mechanical hardening (do first, this week)

**Zero autonomy cost.** These are correctness and "don't-let-strangers-in" fixes. None of them narrow what Alfred can do for its principal; they just close the doors that shouldn't have been open. Do these regardless of what we decide about jailing or taint, because they must hold under every later design.

- **C2** — replace `exec("grep …${url}…")` with `execFile("grep", [args])` (no shell) or do the dedupe check in JS.
- **C3** — fail closed: if a bot token is set but the allowlist is empty, refuse to serve rather than serving all users.
- **H2** — scope `/v1/runs/:runId*` to the requesting session; add a basic rate limiter; `crypto.timingSafeEqual` for the key check.
- **H3** — wrap `code_discover` matching in a timeout (or use `re2`); bound pattern complexity.
- **M1** — stop writing the generated key back into `.env`; store app-managed credentials in a separate file; don't log the raw key.
- **M2** — align the Gemini env var name across code and `.env.example`.
- **M3** — standardize artifact paths on one base so Telegram delivery resolves them.
- **M7** — log errors server-side, return a generic message to clients.
- **L1** — consolidate on the stronger `outputScrubber` implementation; delete the weaker regex.
- **L3** — sanitize rendered markdown in the web UI (DOMPurify).
- **L5** — gitignore + untrack `.DS_Store`.

**Exit criterion:** a stranger who finds the Telegram bot or the gateway port cannot drive Alfred, and no tool string-interpolates untrusted input into a shell.

### Phase 1 — containment without Docker (the real project)

The goal is a **hard, OS-enforced floor** under the blast radius, so that autonomy is cheap to grant. See the [Docker decision](#decision-record-why-not-docker-by-default) below for why this is not a container.

- **Filesystem jail** — run Alfred as a **dedicated low-privilege Unix user** whose home contains only the workspace and whose account cannot read the operator's dotfiles, keys, or SSH. This *dissolves* H1 and L6: the secrets simply aren't reachable, so the per-tool `.env` denylists become unnecessary rather than load-bearing. Secrets Alfred legitimately needs are injected as process env the tools don't expose (aligns with the philosophy doc's vault direction).
- **Egress filter (H4)** — before any fetch, resolve DNS and reject loopback, link-local (`169.254.0.0/16`), and RFC-1918 targets by default; make internal targets explicit opt-in. Alfred still browses the open web autonomously — it just can't pivot to cloud metadata or localhost admin surfaces.
- **Un-jailed posture** — flip default `ALFRED_ENV` away from `dev`/`trusted` so a bare `tsx src/gateway/server.ts` on the host (no jail) is not wide open. The full-power path should require the jail to be in place.

**Exit criterion:** the worst case of a successful prompt injection is bounded to the workspace and the open internet — not the operator's home directory or internal network.

### Phase 2 — provenance-based privilege (discussion below)

With Phase 1 providing the hard floor, taint-tracking provides the *fine-grained* control that keeps the common autonomous cases (research, save, lead-gen) fully hands-off while auto-restricting exactly the injection path. This is the philosophy doc's "instruction provenance" principle made executable at the tool layer. **The design is not yet settled — see the discussion below before implementing.**

### Later (quality / perf, not security-critical)

M4 (run index), M5 (move blocking work off the request path), M6 (MarkdownV2/HTML), L2 (types), L4 (YAML serializer).

---

## Discussion: how should downgraded tool access work?

This is a design conversation, not a settled spec. The aim is a model where **most autonomous work is unaffected**, and the only time a human is pulled in is when a *contaminated* run reaches for a tool it has lost — not at every step.

### The core idea

Mark a run as **contaminated** the moment it ingests untrusted content, and from that point restrict the run to a **safe tool tier**. A run you started by typing an instruction, that never touched the web, stays **clean** and keeps full power.

Clarifying the cost (this is the nuance that matters): a downgrade does **not** make Alfred start prompting you constantly. A contaminated run just quietly has a smaller toolset. You only ever hear from it if it specifically tries to call a tool it no longer has — i.e., the human-in-loop moment is **event-triggered at the forbidden-tool boundary**, and only for the exact actions we'd want a glance at anyway.

### Sources vs. sinks (first thing to nail down)

- **Taint sources** (ingest untrusted content): `web_fetch`, `lead_extractor`, `fetch_tweet`, `pinchtab_fetch`, and arguably `search` result snippets.
- **Safe tier** (always allowed, even contaminated): `search`, `web_fetch`, `file_read`/`file_list`/`code_discover` (workspace-scoped), `file_write` into the workspace, `save_link`'s file-write path, `rag_memory_query`, `doc_qa`.
- **Privileged sinks** (dropped when contaminated): `shell_exec`, `process_stop`, and any future outward-effect tool (email, publish, API POST, spend).

Open question: is `search` a source? If nearly every run starts with a search, treating search results as untrusted means almost every run is contaminated — which collapses the "clean full-power" path to near-nothing and effectively disables `shell_exec`. Leaning toward: **search result *metadata* (titles/URLs) is low-risk; full page *bodies* via `web_fetch` are the real source.** Needs a decision.

### The downgrade policy — two options (choose per tool, not globally)

When a contaminated run reaches a privileged sink:

1. **Silent drop** — the tool isn't there; the model proceeds with what it has and returns a degraded result ("found the fix, can't apply it"). Zero interruption, some tasks dead-end.
2. **Async escalation** — fire a *single* Telegram inline-button approval ("Alfred wants to run `shell_exec: …` on a web-informed task — approve?"). The rest of the run keeps working; only that action waits.

Recommended default: **async escalation for genuinely privileged/irreversible sinks, silent drop for merely-scoped ones.** This keeps the common case fully autonomous and turns the rare risky case into one tap, not a workflow-killer. Wire it through the existing `requiresApproval` stub in `registry.ts` (which currently just rejects).

### The hard part: taint laundering

Taint has to survive indirection or it's theater. If a contaminated run writes scraped text to a workspace file, a *later* "clean" run could `file_read` that file and then `shell_exec` — smuggling untrusted content into a privileged context. To be sound:

- Reading a workspace file whose contents were web-sourced should **re-taint** the reading run.
- This implies tracking provenance on **stored content**, not just live runs — which crosses session boundaries and sub-agent delegation.

This is the main reason taint is a *soft* boundary (our own in-process bookkeeping, defeatable by a tracking bug) and why Phase 1's *hard* jail must land first as the floor. Taint refines; the jail contains.

### Open questions to resolve before building

1. Is `search` a taint source, or only `web_fetch` page bodies?
2. Taint granularity: per-run flag (simple, coarse, sticky) vs. per-message provenance (precise, much more plumbing)?
3. Does contaminated content written to the workspace re-taint future readers — and how do we track that across sessions without a heavy provenance store?
4. Which sinks get silent-drop vs. async-escalation?
5. Does a sub-agent delegation inherit the parent run's taint? (Almost certainly yes.)
6. How does taint interact with the planned capability-grant model — is "clean/contaminated" just a dynamic capability the run holds?

---

## Decision record: why not Docker by default

**Decision:** Docker is **not** the default isolation mechanism. It remains an *optional, documented* path for shared-server / multi-tenant deployments. Default isolation is the dedicated-Unix-user jail (Phase 1).

**Reasoning:**

- **Onboarding tax (primary).** This is an open-source repo whose north star is "simple enough for a 70-year-old, powerful enough for a power user." Every layer between `git clone` and a running agent costs contributors and users. Docker Desktop is a real barrier.
- **Overhead.** On macOS, Docker runs a Linux VM — meaningful RAM and latency cost for a personal agent.
- **Keep-it-on principle.** A guardrail that gets disabled because it's heavy is worse than a lighter one that survives. The Unix-user jail is OS-enforced, near-zero-overhead, and the kind of thing an operator actually leaves running.

**Explicitly rejected reasoning:** "containers aren't agent-like in spirit." Isolation is not the opposite of agency — a bounded blast radius is precisely what makes it safe to *stop* second-guessing the agent and let it act. We skip Docker for the onboarding and overhead reasons, not because containment is philosophically wrong.

**Consistency:** this matches the March philosophy doc, which already deferred WASM/container isolation as "right for a hardened multi-tenant SaaS, overkill for current stage."

---

## Checklist

**Phase 0 (mechanical, no autonomy cost):**
- [ ] C2 — `execFile` in `save_link`
- [ ] C3 — Telegram fail-closed on empty allowlist
- [ ] H2 — session-scope run endpoints, rate limit, timing-safe key compare
- [ ] H3 — regex timeout / `re2` in `code_discover`
- [ ] M1 — stop mutating `.env`; don't log raw key
- [ ] M2 — Gemini env var name
- [ ] M3 — artifact path base
- [ ] M7 — generic client error messages
- [ ] L1 — unify redaction
- [ ] L3 — sanitize UI markdown
- [ ] L5 — `.DS_Store`

**Phase 1 (containment floor):**
- [ ] Dedicated low-priv Unix user + workspace-only home
- [ ] DNS-resolved egress filter (block loopback / link-local / RFC-1918)
- [ ] Retire per-tool `.env` denylists once the jail is real
- [ ] Flip default `ALFRED_ENV` off `trusted` for the un-jailed path

**Phase 2 (provenance):**
- [ ] Resolve the six open questions above
- [ ] Taint flag on runs + source/sink tool classification
- [ ] Re-taint-on-read for web-sourced workspace content
- [ ] Async approval via `requiresApproval` + Telegram inline buttons
