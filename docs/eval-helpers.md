# Eval Helpers

`src/eval-helpers.ts` contains the git and docs helpers that keep eval runs isolated and reproducible.

## Docs Set Definition

The full docs set is exactly: `docs/**/*.md`, `AGENTS.md`, and `CLAUDE.md`. All sync/snapshot helpers use this scope.

## `copyDocsIntoRepo(sourceRepoPath, targetRepoPath)`

Mirrors working-tree docs into a target repo and commits when they changed.

Calls `syncDocsIntoRepo()` internally, then:
- Stages only the changed paths with `git add -A -- <changedPaths>`
- Commits with message `evalbuff: pre-load docs` (only when `changedPaths.length > 0`)
- Leaves the target repo clean after the helper runs

Do not use `fs.cpSync()` as an overlay — it preserves deleted files in the target.

## `syncDocsIntoRepo(sourceRepoPath, targetRepoPath): string[]`

Snapshot mirroring, not overlay copying. Returns sorted list of changed relative paths.

Rules:
- Source of truth is exactly `docs/**/*.md`, `AGENTS.md`, `CLAUDE.md`
- Copies added and modified files from source to target
- Removes target files that are missing from the source snapshot
- Removes now-empty subdirectories under `docs/`
- Does NOT commit — caller decides whether to commit

Used in two places:
- Before coding-agent evals, to preload the latest working-tree docs into cloned repos (via `copyDocsIntoRepo`)
- Before and after docs refactors, to sync docs between source repo and temp clone

## `extractDocsRead(steps: AgentStep[]): string[]`

Returns sorted, deduplicated list of doc paths read by an agent.

Supported tool names:
- `Read` — reads `input.file_path`
- `read_file` — reads `input.path`
- `shell` — parses command string for multiple doc paths (e.g., `cat docs/testing.md AGENTS.md`)

Only paths matching `docs/**` or `AGENTS.md` or `CLAUDE.md` are collected. Works across Claude, Codex, and Codebuff traces because it uses canonical tool names (see `docs/runners.md` for normalization).

## `getGroundTruthDiff(feature: CarvedFeature): string`

Use this instead of `computeGroundTruthDiff()` directly.

- Returns `feature.diff` when non-empty
- Falls back to reconstruction from `operations`/`originalFiles` only for legacy data
- Shared-file cleanup can exist in the real carve diff without appearing in `originalFiles`

## `captureGitDiff(repoPath, { baseRef, pathspecs }): string`

Captures a repo diff safely without staging files.

- Diffs against an explicit base SHA (default: `HEAD`)
- Includes committed changes since `baseRef`, staged, unstaged, and untracked files
- Can be restricted to a pathspec subset
- Never calls `git add .`

This helper exists because agents may create commits during a run; diffing against `HEAD` after the fact misses the real change.

## `getDocsSnapshot(repoPath): Record<string, string>`

Reads the full docs set from the filesystem (working tree, not git index). Returns a map of relative paths to file contents.

## `computeDocsDiffText(before, after): string`

Compares two docs snapshots and produces human-readable diff text with markers: `=== NEW FILE:`, `=== DELETED FILE:`, `=== MODIFIED FILE:`.

## `applyCarveOperations(repoDir, operations: FileOperation[])`

Applies delete/modify operations to a repo directory. Used to carve a feature out of a cloned repo before the coding agent runs.

## `ensureGitIdentity(repoPath)`

Sets `user.name` and `user.email` in a repo (best-effort). Called before committing in temp repos.

## `selectRandom<T>(items, count): T[]`

Shuffles and returns `count` items. Used to pick random carve candidates.

## Test Repo Utilities

`src/test-repo-utils.ts` provides lifecycle helpers for temporary git repos used in testing and evaluation.

### `withTestRepo<T>(repoConfig, fn): Promise<T>`

```ts
withTestRepo({
  repoUrl: string,
  localRepoPath?: string,  // Fast path: local clone via hardlinks
  parentSha: string,
  initCommand?: string,
  env?: Record<string, string>,
}, async (cwd) => { ... })
```

- When `localRepoPath` is provided: `git clone --no-checkout` against local checkout (near-instant via hardlinks)
- Otherwise: `git clone --depth 1 <repoUrl>`, `git fetch --depth 1 origin <sha>`, `git checkout <sha>`
- Runs `initCommand` inside the cloned repo with `env` merged onto `process.env`
- Temp directory is always deleted in `finally`

### `withTestRepoAndParent<T>(repoConfig, fn): Promise<T | null>`

```ts
withTestRepoAndParent({
  repoUrl: string,
  commitSha: string,
  initCommand?: string,
}, async (cwd, commitSha, parentSha) => { ... })
```

- Resolves exactly one parent via `git log --pretty=%P -n 1 <commit>`
- Returns `null` for root commits or merge commits (logs a warning)
- Checks out the parent before invoking the callback
- Temp directory always cleaned up in `finally`
