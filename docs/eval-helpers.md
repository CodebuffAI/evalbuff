# Eval Helpers

`src/eval-helpers.ts` contains the shared Git and docs utilities used across the pipeline. These are the most commonly needed functions when building new features.

## Docs Sync

- **`copyDocsIntoRepo(sourceRepoPath, targetRepoPath)`** — Syncs `docs/*.md`, `AGENTS.md`, and `CLAUDE.md` from source to target, removes stale files from target, and creates a git commit with message `evalbuff: pre-load docs`. This is the standard way to inject docs into a temp clone before running an agent.

- **`syncDocsIntoRepo(sourceRepoPath, targetRepoPath)`** — Lower-level: copies doc files without committing. Returns an array of changed paths. Used by docs-writer workflows that need to sync in both directions (before and after the agent runs).

- **`getDocsSnapshot(repoPath)`** — Returns `Record<string, string>` of all doc file contents (`docs/**/*.md`, `AGENTS.md`, `CLAUDE.md`). Reads working-tree files, not just committed HEAD.

- **`computeDocsDiffText(before, after)`** — Produces a human-readable diff between two docs snapshots.

## Diff Capture

- **`captureGitDiff(repoPath, options?)`** — Captures a unified diff including both tracked changes (vs `options.baseRef`, default `HEAD`) and untracked files. Supports `options.pathspecs` to filter. Uses `--binary` flag. This is how all runners capture their output diffs.

## Carve Operations

- **`applyCarveOperations(repoDir, operations)`** — Applies `FileOperation[]` (delete or modify) to a repo directory. Used to remove a feature before asking an agent to rebuild it.

## Ground Truth

- **`getGroundTruthDiff(feature)`** — Returns the ground-truth diff for judging. Prefers `computeGroundTruthDiff()` which flips the carve into a rebuild diff (+ lines for code to add back). Falls back to `feature.diff` when the rebuilt diff is empty.

## Agent Trace Analysis

- **`extractDocsRead(steps)`** — Scans agent steps for `Read`/`read_file`/`read_files` tool calls and `shell`/`run_terminal_command` calls that reference doc paths. Returns deduplicated, sorted repo-relative paths like `AGENTS.md`, `docs/reference.md`. Handles both relative and absolute paths, normalizing absolute paths to repo-relative form.

## Git Identity

- **`ensureGitIdentity(repoPath)`** — Sets `user.name` and `user.email` in a repo (needed for commits in temp clones).

## Test Repo Clone Helpers

`src/test-repo-utils.ts` provides lifecycle helpers for creating temporary git repo checkouts:

- **`withTestRepo(repoConfig, fn)`** — Creates a temp directory, clones the repo (preferring local hardlink clone via `localRepoPath` when available, otherwise fetching from `repoUrl`), checks out `parentSha`, optionally runs `initCommand` with merged `env`, invokes `fn(cwd)`, and always cleans up the temp directory in `finally`.

- **`withTestRepoAndParent(repoConfig, fn)`** — Fetches `commitSha`, determines parents via `git log --pretty=%P -n 1`, returns `null` for initial or merge commits, otherwise checks out the parent SHA and invokes `fn(cwd, commitSha, parentSha)`.

Both helpers use `getErrorObject()` from `src/vendor/error.ts` for logging init-command failures.

## Testing Helpers

See `docs/testing.md` section "Helper-Contract Tests" for the required test patterns when modifying or extending these helpers. Key rule: always test against real temp git repos, not mocked filesystem calls.
