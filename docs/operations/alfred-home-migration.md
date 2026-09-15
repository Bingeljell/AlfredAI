# Migrating a Source Install to `ALFRED_HOME`

The migration command copies private state out of a source checkout. It does
not delete or alter the source files, update launchctl, or restart Alfred.

Preview the exact source and destination paths first:

```bash
pnpm alfred migrate home
```

The default destination is `~/.alfred`. Choose another absolute location with
`--to`, and use `--source-workspace` if the existing workspace is not
`./workspace/alfred`.

Apply the copy only after reviewing the preview:

```bash
pnpm alfred migrate home --apply
```

The command copies through a private staging directory and atomically renames
it into place. It refuses to overwrite an existing target or place private
state inside the repository. Configuration and identity files receive mode
`0600`; private directories receive mode `0700`.

After migration, set `ALFRED_HOME` in the installed LaunchAgent environment and
restart Alfred. Confirm Web UI, TUI, conversations, tasks, provider status, and
logs before removing any legacy source data. Keeping the old data temporarily
provides rollback: unset `ALFRED_HOME` and restart the original source install.
