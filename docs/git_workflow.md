# Git Workflow

## Branching

- Work on `feature/<description>` or `fix/<description>` branches.
- Never commit directly to `main` unless explicitly instructed.

## Committing

Always use `scripts/committer` — never raw `git add` / `git commit`:

```bash
scripts/committer "commit message" "file1" "file2" ...
```

To commit to `main` (only when explicitly requested):

```bash
scripts/committer --allow-main "commit message" "file1" "file2" ...
```

The script enforces:
- No `.` (must list files explicitly — prevents accidental staging of secrets or unrelated changes)
- No `node_modules` paths
- Clears the staging area first, then adds only the named files
- Errors if on `main`/`master` without `--allow-main`
- `--force` flag removes stale `.git/index.lock` if present

## Pushing

Do not push without explicit instruction. When pushing a feature branch for the first time:

```bash
git push --set-upstream origin feature/<description>
```

## Pull Requests

Open PRs against `main`. Squash merge preferred to keep history clean.
