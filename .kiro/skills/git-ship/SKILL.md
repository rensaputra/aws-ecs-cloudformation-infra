---
name: git-ship
description: Stage changes, write a well-formed commit, push the branch, and open a pull request against the base branch — all from a single instruction. Use this whenever the user says they want to ship, commit, push, or raise a PR.
---

## Workflow

### 1 — Inspect the working tree

```bash
git status
git diff --stat
```

Identify which files are staged, unstaged, or untracked. Report a summary to the user before proceeding; do not silently commit unrelated files.

### 2 — Stage files

If the user named specific files or directories, stage only those:
```bash
git add <paths>
```

If they said "everything" or gave no restriction, stage all tracked changes:
```bash
git add -u
```

Never stage untracked files unless the user explicitly includes them.

### 3 — Write the commit message

Follow the Conventional Commits format:

```
<type>(<scope>): <short summary>

<body — optional, wrap at 72 chars>

<footer — optional, e.g. Closes #123>
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`.

Derive the scope from the primary directory or layer changed (e.g. `vpc`, `alb`, `ecs-service`, `ci`).

Keep the summary under 72 characters, imperative mood ("add", not "added").

Show the message to the user and ask for approval or edits before committing.

### 4 — Commit

```bash
git commit -m "<approved message>"
```

### 5 — Push

```bash
git push --set-upstream origin <current-branch>
```

If the push is rejected (non-fast-forward), report the conflict and ask the user how to proceed; never force-push without explicit instruction.

### 6 — Open the PR

Use the GitHub CLI:
```bash
gh pr create \
  --base main \
  --title "<commit summary>" \
  --body "<PR body>"
```

**Base branch:** `main`. Ask the user only if the branch was cut from a different base.

**PR body template:**

```markdown
## What
<one-paragraph summary of the change>

## Why
<motivation or linked issue>

## Checklist
- [ ] Templates lint clean (`make lint`)
- [ ] Security scan passes (`make scan`)
- [ ] Tests pass (`make test`)
```

Populate `What` from the commit message and staged diff. Leave `Why` blank for the user to fill in unless they provided context.

PRs are opened as **ready-for-review** by default. Add `--draft` only if the user asks.

## Constraints

- Never force-push (`--force` / `--force-with-lease`) unless the user explicitly asks.
- Never amend a commit that has already been pushed.
- Never bypass CI checks or add `--no-verify`.
- Confirm the target base branch with the user before opening the PR only if it differs from `main`.
- If `gh` is not installed or not authenticated, fall back to printing the PR URL template and ask the user to open it manually.

## Project context

- Repo: `https://github.com/rensaputra/aws-ecs-cloudformation-infra`
- Default base branch: `main`
- Conventional scope values that map to this project's layers: `vpc`, `security-groups`, `alb`, `ecs-cluster`, `ecs-service`, `ci`, `docs`, `test`
