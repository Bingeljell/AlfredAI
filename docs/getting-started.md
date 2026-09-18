# Getting Started

Alfred has two installation paths. Choose the product installation if you want
to use and update Alfred. Clone the repository only if you intend to change
Alfred's core code.

## Product installation

The npm package is not public yet. Once a package name and license are selected
and the first prerelease is published, the supported flow will be:

```bash
npm install --global <published-package-name>
alfred setup
alfred doctor
alfred start
```

`alfred setup` asks for your name and LLM provider, then creates private state
under `~/.alfred`. It does not ask you to paste API keys into a visible prompt.
For an API-key provider, add the requested key to
`~/.alfred/config/config.env`, which is created with mode `0600`.

For a non-interactive OpenRouter setup:

```bash
alfred setup \
  --name "Your Name" \
  --provider openrouter \
  --model openai/gpt-4o-mini
```

Then add `OPENROUTER_API_KEY` to the private configuration file and run
`alfred doctor` again. The active provider is exactly the configured
`ALFRED_LLM_PROVIDER`; a connected ChatGPT account is an explicitly selectable
alternative, never an automatic fallback.

For a ChatGPT subscription:

```bash
alfred setup --name "Your Name" --provider codex --model gpt-5
alfred auth login openai
alfred auth status openai
alfred doctor
```

By default this uses the Codex CLI account on the machine. To keep Alfred on a
different ChatGPT account, configure a dedicated `CODEX_HOME` before login; see
[ChatGPT subscription operations](operations/chatgpt_subscription.md).

### Talk to Alfred

Keep `alfred start` running, then use either interface:

```bash
alfred tui
```

Or open `http://localhost:9001/ui` in a browser. In the TUI, Ctrl-Q detaches
without stopping Alfred. Ctrl-P opens the conversation picker.

On macOS, install the background service after foreground startup works:

```bash
alfred service install
alfred service status
```

Configuration changes require `alfred service restart`. To remove autostart
without deleting identity, chats, tools, or settings, run
`alfred service uninstall`.

### Update and extend

After public releases begin, update the replaceable application code with npm.
The exact command and release channel will be documented with the first
prerelease. Everything under `ALFRED_HOME` remains user-owned.

Packaged Alfred can create tools under `ALFRED_HOME/extensions`. These tools
survive package upgrades, but they are disabled until you review and approve
their exact digest. Enabled extensions are trusted local JavaScript with the
same operating-system permissions as Alfred. See the
[extension trust model](operations/extensions.md).

## Source development

Requirements: Node.js 22.18 or newer and pnpm.

```bash
git clone https://github.com/Bingeljell/AlfredAI.git
cd AlfredAI
corepack enable
pnpm install
cp .env.example .env
```

Configure `.env`, then validate and start the checkout:

```bash
pnpm tsc --noEmit
pnpm test
pnpm alfred start
```

In a second terminal:

```bash
pnpm alfred tui
```

Source mode retains the repository-local compatibility layout unless you set
`ALFRED_HOME`. Core tools live in `src/tools/definitions/`; contributors should
read `AGENTS.md` before changing the codebase. Personal identity, credentials,
conversation state, generated artifacts, and machine service definitions must
not be committed.

Existing checkout users can preview a non-destructive migration with:

```bash
pnpm alfred migrate home
```

Review the reported source and target paths before repeating it with `--apply`.
See the [migration guide](operations/alfred-home-migration.md).

## Optional capabilities

- Search: configure SearXNG, Bright Data, or Brave.
- Interactive browsing: run `pnpm setup:browsers` in a checkout. Packaged-user
  browser installation will be finalized before the public prerelease.
- Telegram: set `TELEGRAM_BOT_TOKEN` and a fail-closed
  `TELEGRAM_ALLOWED_USER_IDS` allowlist.
- Long-term semantic recall: install QMD and index Alfred's knowledge directory.
- Scheduling: set `ALFRED_SCHEDULER_ENABLED=true`; it is off by default.

These are optional. A valid LLM provider is the only external capability needed
for a first Web UI or TUI conversation.
