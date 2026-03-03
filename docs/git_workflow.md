# Git Workflow

This repository follows a small, reversible workflow for safe iteration.

## Branching Rules

- Never commit directly to `main` unless explicitly requested.
- Work on feature/fix branches:
  - `feature/<short-description>`
  - `fix/<short-description>`

## Commit Rules

- Always commit with `scripts/committer`.
- Do not use direct `git add`/`git commit` unless explicitly asked.
- Keep commits small and logical.
- Stage only explicit file paths in each commit.

## Commit Commands

- Normal commit:
  - `scripts/committer "your commit message" "path/file1" "path/file2"`
- If a main-branch commit is explicitly requested:
  - `scripts/committer --allow-main "your commit message" "path/file1"`

## Push Rules

- Push your branch after a successful commit:
  - `git push -u origin <branch-name>` (first push)
  - `git push` (subsequent pushes)

## Validation Before Commit

- Run available project checks/tests before committing.
- If no test/build tooling exists yet, record that in your handoff/update.

## First-Commit Bootstrap

- `scripts/committer` supports first commits on an unborn branch and can be used for repository bootstrap commits.
