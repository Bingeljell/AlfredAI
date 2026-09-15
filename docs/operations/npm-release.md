# Npm Release Runbook

No package is published by the current automation. `package.json` intentionally
remains `private: true` and `UNLICENSED` until the maintainers make the public
identity and licensing decisions below.

## One-time release decisions

1. Select and reserve the npm package name or scope. The current `alfredv1`
   name is a working placeholder, not a promised public identifier.
2. Select an open-source or source-available license and add the corresponding
   `LICENSE` file. Do not remove `private: true` first.
3. Confirm the public support, security-reporting, and repository URLs.
4. Decide whether the first supported hosts are macOS only or macOS plus Linux;
   foreground mode is cross-platform, while managed services are currently
   macOS-only.

## Prerelease procedure

1. Merge the packaging stack using normal merge commits in its documented
   order.
2. Run CI on `main` and require every release gate to pass.
3. Change the final package metadata in one dedicated release PR: name, version,
   license, repository, bugs, homepage, and `private`.
4. Run `pnpm pack:check` and `pnpm smoke:package` from a clean checkout.
5. Inspect `npm pack --dry-run` manually. It must contain only the allowlisted
   compiled runtime, launcher, Web UI, templates, README, and manifest.
6. Publish a prerelease with npm provenance and the `next` dist-tag from CI.
   Never publish `latest` directly from a developer laptop.
7. Install `next` on a separate test account/machine. Test setup, each provider
   family, ChatGPT account isolation, Web UI, TUI, Telegram, extensions,
   restart, upgrade, rollback, and uninstall/data retention.
8. Promote the already-tested version to `latest`; do not rebuild a different
   artifact for promotion.

## Non-negotiable release gates

- No `.env`, credential, workspace, conversation, artifact, local agent config,
  owner-specific identifier, or machine-specific service file is in the
  tarball.
- A clean install works outside a Git checkout without pnpm or TypeScript.
- `ALFRED_HOME` is the only default mutable product-data root and survives
  install, update, rollback, and service uninstall.
- `AGENTS.md` remains contributor guidance and is absent from runtime prompts
  and the npm artifact.
- Setup does not expose secrets; doctor never prints secret values.
- User-space extension activation is explicit, digest-bound, and described as
  trusted host code rather than a sandbox.
- Publishing requires an immutable tag, protected environment approval,
  short-lived npm trusted publishing, and provenance.

The GitHub CI workflow validates code and the exact consumer-install path but
does not contain a publish job. Add publishing only in the dedicated release PR
after all one-time decisions are resolved.
