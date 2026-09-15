# npm Distribution, Onboarding, and Privacy Boundary

**Status:** implementation plan and public-repository audit  
**Date:** 2026-09-15

## Decision

Alfred should support two deliberately different installation modes:

1. **Product installation** for people who want to use Alfred. The supported
   path is a globally installed npm package with a guided setup flow.
2. **Source installation** for developers who want to change Alfred itself.
   The supported path is cloning the repository and using pnpm.

The npm package owns replaceable application code. The user owns configuration,
identity, credentials, conversations, artifacts, and logs outside the package.
An npm upgrade must never overwrite user-owned state.

Target product flow:

```bash
npm install --global @scope/alfred
alfred setup
alfred start
alfred tui
```

Target source-development flow:

```bash
git clone https://github.com/Bingeljell/AlfredAI.git
cd AlfredAI
corepack enable
pnpm install
pnpm setup
pnpm dev:gateway
```

The final npm scope and package name remain a release decision. The command
name should remain `alfred` unless a collision requires `alfred-ai`.

## Product boundary

### Package-owned, replaceable files

The npm package may contain only what is required to execute Alfred:

```text
bin/                 executable launcher
dist/                compiled JavaScript runtime
webui/               static browser client
templates/           generic identity and service templates
package.json         executable/package metadata
README.md             concise product documentation
LICENSE               distribution license
```

Tests, source-only scripts, local agent settings, development instructions,
design notes, generated artifacts, machine-specific service files, and private
instance state must not enter the tarball.

Use the `files` allowlist in `package.json` as the primary publication boundary.
Do not rely on `.gitignore` or a broad `.npmignore` denylist.

### User-owned, persistent files

Introduce `ALFRED_HOME`. For the first cross-platform release, default it to
`~/.alfred` and allow an absolute override.

```text
~/.alfred/
├── config/
│   ├── config.env             mode 0600; secrets and runtime settings
│   └── config-version         migration schema version
├── identity/
│   ├── SOUL.md                user-personalized identity
│   └── INSTRUCTIONS.md        optional user instructions
├── workspace/
│   ├── sessions/
│   ├── groups/
│   ├── knowledge/
│   ├── scheduler/
│   ├── runs/
│   └── artifacts/
├── logs/
├── run/                       PID and transient process state
└── backups/                   migration/config backups
```

The package must never write into its own installation directory. All mutable
paths must be resolved from `ALFRED_HOME` or an explicit override.

### Developer-only files

`AGENTS.md` describes how contributors change this repository. It is not an
end-user prompt and must never be injected wholesale into Alfred's packaged
runtime. Generic memory, efficiency, temporal, output, and self-development
principles belong in a compiled product operating contract. User-specific
preferences belong in private `ALFRED_HOME/identity/INSTRUCTIONS.md`.
Repository-local IDE/agent files such as `.claude/`, `.codex/`, and `.agents/`
are also development configuration and must remain outside the npm package.

## Required runtime refactor

### 1. Separate application defaults from personal identity

Current behavior in `src/runtime/specialists.ts` reads `SOUL.md` and
`AGENTS.md` from `process.cwd()` when the module loads. Replace this with an
explicit prompt loader:

- immutable product prompt from compiled package resources;
- personalized `SOUL.md` from `ALFRED_HOME/identity/SOUL.md`;
- optional user `INSTRUCTIONS.md` from the same private directory;
- no runtime loading of repository `AGENTS.md`;
- generic language such as “the user” or “the principal” in shipped source;
- safe fallback to the packaged default soul when personalization is missing.

The source checkout may point `ALFRED_HOME` at a repo-local ignored directory
for development, but the checked-in `SOUL.md` must remain a generic template.

### 2. Stop treating the current working directory as the installation root

Audit and replace uses of `process.cwd()` that mean one of three different
things today:

- package resource root;
- user workspace root;
- project directory available to tools.

Introduce typed path resolution with explicit names, for example:

```text
packageRoot      read-only installed application resources
alfredHome       private persistent root
workspaceDir     Alfred-owned data and artifacts
toolProjectRoot  optional directory a user has deliberately granted
```

Static Web UI files and templates must resolve relative to the installed
package, not the shell's working directory. Tools must receive an explicit,
authorized project root rather than inheriting the launch directory.

### 3. Move configuration out of repository `.env`

The product install should load `ALFRED_HOME/config/config.env`. Process
environment variables remain the highest-precedence override for containers,
automation, and advanced users.

Requirements:

- create the file with mode `0600`;
- write atomically;
- never print complete secret values;
- show only presence or a short fingerprint in status output;
- preserve unknown keys during upgrades;
- validate before replacing a working configuration;
- create a timestamped backup before migrations;
- never copy the developer checkout's `.env` into a product installation.

ChatGPT/Codex credentials remain owned by Codex. A dedicated `CODEX_HOME` can
be placed under `ALFRED_HOME` when the user requests an account isolated from
their normal Codex CLI login.

### 4. Compile the production runtime

The published executable must not depend on `tsx` or repository TypeScript
sources at runtime.

- compile `src/` and the CLI to `dist/`;
- add a small executable launcher with a Node shebang;
- move `tsx`, TypeScript, ESLint, and test packages to development-only use;
- declare the supported Node range in `engines`;
- verify a clean install in an empty directory with no source checkout;
- ensure runtime dynamic imports and tool discovery work from compiled files.

### 5. Make tool discovery package-safe

The built-in registry currently discovers `*.tool.ts` files from the source
tree. It must discover compiled built-ins from `dist/tools/definitions/`.

Custom core tools remain a source-checkout feature. Npm users must still be
able to let Alfred build upgrade-safe user-space tools without modifying the
installed package. Add a versioned extension system under
`ALFRED_HOME/extensions/` with:

- a manifest declaring name, entry point, compatible Alfred versions, inputs,
  outputs, and requested capabilities;
- `alfred tools create`, `install`, `test`, `enable`, `disable`, and `list`
  commands;
- an explicit review and activation step before executable code is loaded;
- isolated build/test output and bounded execution permissions;
- registry errors that disable one extension without preventing Alfred from
  starting;
- upgrade compatibility checks and a user-controlled migration path.

Do not silently execute arbitrary JavaScript merely because it exists in a
user directory. Alfred may author and test an extension, but activation must
remain an explicit trust decision. This preserves self-expansion for npm users
while keeping core product changes in the source-development workflow.

## CLI and onboarding

### Command surface

The installed CLI should expose:

```text
alfred setup                  first-run and reconfiguration wizard
alfred doctor                 read-only installation and connectivity checks
alfred start                  foreground gateway
alfred stop                   stop an installed background service
alfred restart                restart an installed background service
alfred status                 service, provider, account, and endpoint status
alfred tui                    terminal client
alfred config                 reopen configuration safely
alfred auth ...               provider authentication commands
alfred tools ...              create and manage user-space extensions
alfred service install        install OS background service
alfred service uninstall      remove OS background service, retain user data
alfred version                installed/runtime/config versions
alfred update --check         report available npm release without mutation
```

Package-manager installation and upgrades should remain explicit in the first
release (`npm install --global ...` / `npm update --global ...`). A self-updater
can be considered only after rollback and migration behavior is proven.

### `alfred setup` flow

The wizard must be idempotent and safe to rerun:

1. Detect OS, architecture, Node version, package version, write access, and
   port availability.
2. Explain the product/private-data boundary and show the resolved
   `ALFRED_HOME` before writing.
3. Create private directories and configuration with restrictive permissions.
4. Ask for the user's preferred name, timezone, and communication style, then
   render a private `SOUL.md` from a generic template.
5. Choose exactly one active LLM provider.
6. Collect only that provider's required configuration and mask secrets.
7. Validate credentials or local-provider reachability before continuing.
8. Discover and select live models where the provider supports discovery.
9. For ChatGPT/Codex, check the Codex CLI/App Server and run its supported
   browser or device-code login flow.
10. Offer optional Telegram setup and verify both the bot token and numeric
    allowlist without printing them.
11. Offer browser/search capabilities individually; avoid downloading a large
    browser during npm `postinstall`.
12. Offer the autonomous scheduler with a clear explanation that it keeps the
    background process active.
13. Generate the Web/API access key and print the Web UI URL.
14. Offer background-service installation, separately from configuration.
15. Run `alfred doctor` and finish with commands for Web UI, TUI, logs, status,
    update, and uninstall.

Cancellation must leave either the prior valid configuration or a clearly
marked incomplete staging directory. Existing values must be preserved unless
the user explicitly changes them.

### `alfred doctor`

`doctor` must be read-only by default and return a nonzero exit code for hard
failures. It should check:

- package/runtime/config schema versions;
- `ALFRED_HOME` permissions and required directories;
- malformed or missing configuration without exposing values;
- active provider credentials and model reachability;
- Codex installation, authentication, live catalog, and quota endpoints;
- gateway port, API key, Web UI assets, and single-instance lock;
- Telegram configuration and allowlist shape;
- optional SearXNG, Pinchtab, Playwright, QMD, and Herdr dependencies;
- service definition, executable path, process state, and recent crash loop;
- whether an npm update is available, only when explicitly requested or when
  network checks are enabled.

Provide machine-readable output through `--json`, with all secret-bearing
fields reduced to booleans or fingerprints.

## Background services

Replace checked-in machine-specific service definitions with rendered generic
templates.

For macOS:

- use a stable label such as `com.alfred.agent`;
- generate the plist during `alfred service install`;
- resolve the installed `alfred` executable and `ALFRED_HOME` dynamically;
- use `alfred start --foreground` as the service command;
- store logs under `ALFRED_HOME/logs`;
- validate with `plutil` before loading;
- use modern `launchctl bootstrap`, `bootout`, and `kickstart` operations;
- make install/uninstall idempotent;
- never remove `ALFRED_HOME` during service uninstall.

Linux systemd support can follow the same contract. Unsupported platforms must
still support foreground mode and must receive an honest message rather than a
partially installed service.

## Updates and migrations

Publishing frequent updates is safe only when code and data versions are
independent.

- use semantic package versions;
- publish `latest` only from a tagged, fully validated release;
- use an npm prerelease tag such as `next` for testers;
- record a separate configuration/data schema version;
- make migrations ordered, idempotent, and covered by fixtures from older
  releases;
- back up changed user files before migrating;
- never run destructive migrations during npm `postinstall`;
- run migrations explicitly on the next `alfred setup`, `alfred start`, or
  dedicated migration command, with a dry-run path for risky changes;
- retain enough previous metadata to explain rollback compatibility;
- show release notes and restart requirements after an update.

## npm package and release controls

Required `package.json` work:

- replace the placeholder `alfredv1` name with the chosen scoped name;
- remove `private: true` only when release gates pass;
- add `bin`, `files`, `engines`, `license`, `repository`, `bugs`, `homepage`,
  `keywords`, and publish configuration;
- keep a minimal production dependency set;
- replace the current browser-downloading `postinstall` with an explicit setup
  choice;
- add `prepack` that cleans and builds into a staging directory;
- add `pack:check` that fails if the tarball contains unexpected files;
- fail publishing from a dirty worktree or an untagged/version-mismatched
  commit.

Release CI must:

1. install from the lockfile;
2. type-check, lint, and run unit/integration/security/smoke tests;
3. build production output;
4. run secret and PII scans on the tree and release history;
5. inspect the exact `npm pack --dry-run --json` manifest;
6. install the tarball into an empty temporary environment;
7. run CLI help, setup dry-run, doctor, gateway, Web UI, and TUI smoke tests;
8. publish with npm provenance/trusted publishing where available;
9. attach checksums and release notes to the corresponding GitHub release.

## README restructure

The README should become a product entry point, not the complete operations
manual. Proposed order:

1. What Alfred is, with a screenshot and a concise safety statement.
2. **Install Alfred**: npm prerequisites, install, setup, Web UI, and TUI in
   under one screen.
3. **Choose a provider**: supported providers, active-versus-standby behavior,
   ChatGPT account isolation, and model selection.
4. **What Alfred can do**: current feature matrix.
5. **Surfaces**: Web UI, TUI, and Telegram continuity.
6. **Autonomy and memory**: scheduler, reminders, watches, sessions, knowledge,
   and artifacts.
7. **Tools and integrations**: search, browser, QMD, Herdr, webhooks, and
   optional dependencies.
8. **Security and private data**: `ALFRED_HOME`, permissions, credential
   ownership, backups, and uninstall behavior.
9. **Operate and update**: service, status, logs, doctor, and npm updates.
10. **Develop Alfred**: clone/pnpm workflow and links to architecture docs.

Detailed environment tables and platform procedures should move to focused
operations documents linked from the README.

The feature matrix must be generated or verified against the actual runtime
allowlist and configuration schema so new features cannot silently disappear
from documentation.

## Privacy and public-repository audit

### Audit scope and method

The 2026-09-15 audit covered:

- all currently tracked files;
- ignored/private path behavior;
- credential-prefix, private-key, email, local-path, account-ID, and personal-
  name heuristics;
- Git history searches for credential-shaped additions and any tracked `.env`;
- Git commit identity metadata;
- media container metadata;
- the exact npm dry-run manifest;
- GitHub repository visibility and secret-scanning alerts.

This is a strong baseline, not a mathematical guarantee. A maintained secret
scanner must become a CI and pre-publish control rather than relying only on
ad-hoc regexes.

### Results

#### No live credential exposure found

- The repository is public, as expected.
- GitHub currently reports zero secret-scanning alerts.
- No tracked `.env` exists, and no `.env` object was found in repository
  history.
- `workspace/`, `.env`, and `*.log` are ignored.
- Credential-shaped history matches were deliberate redaction test canaries,
  not usable secrets.
- No tracked private-key/certificate files were found.
- The checked-in root `SOUL.md` is currently templated with `[your name]` and
  does not contain the owner's identity.

No credential rotation or Git history rewrite is indicated by this audit.

#### Publication blockers

These must be addressed before removing `private: true`:

1. **Tracked `.claude/settings.local.json`.** It contains a personal absolute
   path and a broad local `Bash(*)` permission. Remove it from tracking, ignore
   local agent settings, and retain only an intentionally generic example if
   one is useful.
2. **Tracked `scripts/com.nikhil.alfred.plist`.** It contains the owner's macOS
   username, home and project paths, binary locations, log locations, and a
   personal service label. Remove it from the public tree after replacing it
   with the generic service generator/template.
3. **Runtime prompt personalization.** `src/runtime/specialists.ts` contains the
   owner's name, personal memory conventions, a personal launchctl label, and
   repository self-development instructions. This is both a privacy boundary
   problem and incorrect behavior for other users.
4. **Developer instructions injected at runtime.** `AGENTS.md` contains owner-
   specific operating notes and is currently included in Alfred's system
   prompt. Stop runtime injection; keep it solely for repository contributors.
5. **Hard-coded owner text in tools.** `src/tools/definitions/logSession.tool.ts`
   tells the model to save what the owner should remember. Replace it with
   user-neutral language.
6. **Personal narrative documents.** `docs/architecture/alfred-identity.md`,
   `docs/architecture/security-philosophy.md`, `docs/spec.md`,
   `docs/features/herdr_control.md`, and parts of the webhook specification name
   the owner or describe personal incidents. Decide deliberately whether each
   is useful public product history; otherwise genericize or archive it outside
   the product repository.
7. **Generated artifacts tracked in the repository.** `artifacts/scratch.md`
   and `artifacts/ui-session-analysis.md` are development residue. Remove them
   from tracking and ignore the generated artifact directory.
8. **No npm allowlist.** The current dry run would publish 297 files, roughly
   5 MB packed / 6.7 MB unpacked, including `.claude` settings, `AGENTS.md`,
   `SOUL.md`, artifacts, all tests and fixtures, all internal docs, TypeScript
   source, and the machine-specific plist. A strict `files` allowlist is a
   release blocker.

#### Low-risk public identifiers

- Existing commit history exposes author names and email addresses in ordinary
  Git metadata. This is not a secret leak, but future commits can use a GitHub
  no-reply address if desired. Rewriting history solely for this is not
  recommended.
- The public GitHub username and owner name appear in authorship/specification
  metadata. These are attribution choices, not credentials.
- The MP4 asset contains an opaque signature comment but no detected author,
  location, or account metadata. Media should still be excluded unless the
  product genuinely uses it and its origin/license is documented.

### Permanent privacy controls

Add the following before public npm release:

- CI secret scan for pushes, pull requests, tags, and the packed tarball;
- pre-publish PII/local-path scan with an explicit allowlist for fixtures;
- a test that rejects tracked `.env`, credentials, private keys, workspace
  state, logs, local IDE/agent settings, and machine-specific service files;
- a test that asserts the exact package file allowlist;
- a test that scans shipped runtime prompts for owner names, absolute home
  paths, and developer-only instructions;
- a documented incident process: stop publication, revoke the release,
  rotate credentials, remove the secret from current state, and rewrite
  history only when an actual secret entered Git;
- release review of media provenance, license, and metadata;
- user-facing `alfred privacy` or `alfred doctor --privacy` output that lists
  private storage locations without revealing their contents.

## Implementation sequence

### Phase 0 — Public-tree cleanup

- Remove tracked local agent settings, machine plist, and generated artifacts.
- Genericize owner-specific runtime strings and selected public docs.
- Stop loading `AGENTS.md` into the runtime prompt.
- Add repository privacy tests and secret scanning.

**Gate:** current tree, GitHub scan, and package-manifest scan show no private
instance files or owner-specific runtime behavior.

### Phase 1 — Path and state separation

- Introduce `ALFRED_HOME` and typed path resolution.
- Move config, identity, workspace, logs, and PID state outside package files.
- Add safe first-run migration from a source checkout, without copying secrets
  unless the user explicitly approves the target.

**Gate:** deleting/replacing the installed package leaves all user data intact;
two isolated `ALFRED_HOME` values can run without sharing state.

### Phase 2 — Production CLI and build

- Compile runtime and CLI.
- Add the executable command surface.
- Make static assets and built-in tool discovery installation-root-safe.
- Add the versioned user-space extension SDK, loader, capability review, and
  `alfred tools` lifecycle commands.
- Add `setup` and `doctor` with automated tests.

**Gate:** the packed tarball installs and runs from an empty directory with no
Git checkout, pnpm, or `tsx`; an npm-installed Alfred can author, test, and
explicitly activate a simple extension that survives a package upgrade.

### Phase 3 — Service lifecycle

- Generate and manage the macOS LaunchAgent.
- Add safe status/log/restart/uninstall operations.
- Keep foreground mode fully supported.

**Gate:** install, restart after npm replacement, and uninstall are idempotent;
uninstalling the service retains private user data.

### Phase 4 — Documentation and release automation

- Rewrite the README around product and developer paths.
- Add release CI, package-content tests, clean-install smoke tests, provenance,
  prerelease channel, and changelog/release-note automation.

**Gate:** a new user can go from npm install to a successful first conversation
without editing a repository file.

### Phase 5 — First npm prerelease

- Reserve the package scope/name.
- Publish a `next` prerelease.
- Test clean install, upgrade, rollback, config migration, ChatGPT login,
  API-key provider setup, Web UI, TUI, Telegram, and launchctl on a separate
  machine/account.
- Promote the same verified artifact to `latest` only after the test window.

## Release acceptance checklist

- [ ] No personal name, home path, account identifier, service label, or local
      agent permission appears in shipped runtime files.
- [ ] `SOUL.md` and user instructions are private, persistent, and upgrade-safe.
- [ ] `AGENTS.md` is developer-only and absent from runtime prompts/package.
- [ ] No `.env`, credentials, logs, conversations, artifacts, or workspace data
      can enter the tarball.
- [ ] Package manifest is an allowlist and verified in CI.
- [ ] Installation works without a Git checkout or pnpm.
- [ ] Setup is idempotent, masks secrets, validates the active provider, and can
      recover safely from cancellation.
- [ ] Upgrades preserve private data and run tested, reversible migrations.
- [ ] Service definitions contain generated paths only on the user's machine.
- [ ] Foreground, Web UI, TUI, provider auth, and service smoke tests pass from
      the exact tarball.
- [ ] README clearly separates npm users from source contributors.
- [ ] Secret/PII/history/package scans pass immediately before publication.
