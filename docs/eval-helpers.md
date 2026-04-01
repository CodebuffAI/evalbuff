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

**Warning**: `runAgentOnCarve()` must call `copyDocsIntoRepo(docsSourcePath, repoDir)` — not inline docs syncing with `fs.cpSync` or any other overlay copy. `docsSourcePath` is the working-tree repo that owns the latest docs and may differ from the repo used for `git clone`.

**Why overlay copies fail**: An `fs.cpSync`-style overlay keeps files in the target that were deleted in the source. If the source has `docs/guide.md` and `AGENTS.md` but the target also has stale `docs/old.md` and `CLAUDE.md`, the stale files survive and mislead the coding agent. `syncDocsIntoRepo()` removes them. Postcondition: target contains exactly the source docs set, commit message is `evalbuff: pre-load docs`, and `git status --short` is empty.

## `syncDocsIntoRepo(sourceRepoPath, targetRepoPath): string[]`

Pure filesystem mirror — no git side effects. Returns sorted list of changed relative paths.

Rules:
- Source of truth is exactly `docs/**/*.md`, `AGENTS.md`, `CLAUDE.md`
- Copies added and modified files from source to target
- Removes target files that are missing from the source snapshot
- Removes now-empty subdirectories under `docs/`
- Does NOT call `git add` or `git commit` — caller decides whether to commit
- Does NOT stage or commit unrelated repo changes

Used in two places:
- Before coding-agent evals, to preload the latest working-tree docs into cloned repos (via `copyDocsIntoRepo`)
- Before and after docs refactors, to sync docs between source repo and temp clone

## `extractDocsRead(steps: AgentStep[]): string[]`

Returns sorted, deduplicated list of doc paths read by an agent.

Supported tool names (canonical only — see `docs/runners.md` for normalization):
- `Read` — reads `input.file_path`
- `read_file` — reads `input.path`
- `shell` — parses the command string for all doc path mentions (e.g., `cat docs/testing.md AGENTS.md`)

Only paths matching `docs/**`, `AGENTS.md`, or `CLAUDE.md` are collected.

### Path Normalization

All paths are normalized to repo-relative form before deduplication:
- Absolute paths like `/tmp/x/docs/reference.md` → `docs/reference.md`
- Relative paths like `./docs/extra.md` → `docs/extra.md`
- Shell commands may mention multiple paths: `cat docs/guide.md AGENTS.md && sed -n '1,5p' ./docs/extra.md` → `["AGENTS.md", "docs/extra.md", "docs/guide.md"]`

## `getGroundTruthDiff(feature: CarvedFeature): string`

Use this instead of `computeGroundTruthDiff()` directly.

- Returns `feature.diff` when non-empty
- Falls back to reconstruction from `operations`/`originalFiles` only for legacy data
- Shared-file cleanup can exist in the real carve diff without appearing in `originalFiles`

## `captureGitDiff(repoPath, { baseRef, pathspecs }): string`

Captures a repo diff safely. **Must be side-effect free** — `git status --short` must be unchanged before and after the call.

- Diffs against an explicit base SHA (default: `HEAD`)
- Includes committed changes since `baseRef`, staged, unstaged, and untracked files
- Can be restricted to a pathspec subset
- Never calls `git add`, including `git add -N`
- Never modifies the staging area

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
- `initCommand` is best-effort setup, not a hard failure. Runs `execSync(initCommand, { cwd: repoDir, stdio: 'ignore', env: { ...process.env, ...env } })` inside a `try/catch`. On failure, logs `Error running init command: <message>` via `getErrorObject(error).message` and still invokes the callback.
- Temp directory cleanup in `finally` is wrapped so `fs.rmSync(..., { recursive: true, force: true })` only warns on failure and never overrides the callback result.

### `withTestRepoAndParent<T>(repoConfig, fn): Promise<T | null>`

```ts
withTestRepoAndParent({
  repoUrl: string,
  commitSha: string,
  initCommand?: string,
}, async (cwd, commitSha, parentSha) => { ... })
```

Exact commit-level evaluation sequence:
1. `git clone --depth 1 <repoUrl> <repoDir>`
2. `git fetch --depth 2 origin <commitSha>`
3. `git checkout <commitSha>` (the repo briefly checks out the target commit)
4. Resolve parents with `git log --pretty=%P -n 1 <commitSha>` — returns `null` for zero or multiple parents
5. `git checkout <parentSha>` before invoking `fn(cwd, commitSha, parentSha)`

**Note**: Do not substitute `FETCH_HEAD` or a custom `git init` bootstrap — the task prompt and tests assume the repo checks out the target commit before rewinding to the parent.

Both helpers are required public exports in `src/test-repo-utils.ts`.
