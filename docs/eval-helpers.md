# Eval Helpers & Git Utilities

Core utilities in `src/eval-helpers.ts` and `src/test-repo-utils.ts` for repo lifecycle, docs handling, and trace analysis.

## `withTestRepo(repoConfig, fn)` — `src/test-repo-utils.ts`

Creates an isolated temp repo clone, runs a function, then always cleans up.

```typescript
withTestRepo<T>(
  repoConfig: {
    repoUrl: string
    localRepoPath?: string   // Prefer this — uses hardlinks, near-instant
    parentSha: string        // The commit to check out (parent of the change to replicate)
    initCommand?: string     // e.g. "npm install" — runs best-effort, errors logged not thrown
    env?: Record<string, string>
  },
  fn: (cwd: string) => Promise<T>
): Promise<T>
```

Key behaviors:
- Temp dir: `fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-eval-'))`
- Local clone: `git clone --no-checkout` (hardlinks, fast)
- Remote clone: `git clone --depth 1` + `git fetch --depth 1 origin <sha>`
- Init command runs with `env: { ...process.env, ...env }` — failure is logged but doesn't abort
- Temp dir always deleted in `finally`

## `withTestRepoAndParent(repoConfig, fn)` — `src/test-repo-utils.ts`

Like `withTestRepo` but resolves the parent commit automatically.

```typescript
withTestRepoAndParent<T>(
  repoConfig: { repoUrl: string; commitSha: string; initCommand?: string },
  fn: (cwd: string, commitSha: string, parentSha: string) => Promise<T>
): Promise<T | null>
```

Key behaviors:
- Shallow-clones the target commit, inspects `git log --pretty=%P -n 1 <commitSha>`
- Returns `null` with a warning for **initial commits** (no parent) or **merge commits** (multiple parents)
- **Never silently picks the first parent of a merge commit** — this is intentional
- Checks out the single parent, then invokes callback

## `copyDocsIntoRepo(sourceRepoPath, targetRepoPath)` — `src/eval-helpers.ts`

Copies `docs/`, `AGENTS.md`, and `CLAUDE.md` from source to target and commits.

**Gotcha:** `docs/`, `AGENTS.md`, and `CLAUDE.md` are each optional and independent. The helper must create the commit `evalbuff: pre-load docs` whenever *any* subset was copied. The current implementation uses `2>/dev/null` to tolerate missing paths in `git add`:

```bash
git add docs/ AGENTS.md CLAUDE.md 2>/dev/null
```

**Verification rule:** After calling the helper in a temp git repo with only `docs/` plus `AGENTS.md` (no `CLAUDE.md`), `git log -1 --pretty=%s` must be `evalbuff: pre-load docs` and `git status --short` must be empty.

## `extractDocsRead(steps)` — `src/eval-helpers.ts`

Returns a sorted, deduplicated list of doc files read by an agent during execution.

```typescript
extractDocsRead(steps: AgentStep[]): string[]
```

Detects doc references from three tool types:
- **`Read`** / **`read_file`**: checks `input.file_path` or `input.path`
- **`shell`**: scans `input.command` for doc path patterns

Recognized path forms: `docs/foo.md`, `./docs/foo.md`, `/abs/path/docs/foo.md`, `AGENTS.md`, `./AGENTS.md`, `CLAUDE.md`

**Important for shell detection:** The regex must match doc paths anywhere in the command string, not just at the start. Real traces contain commands like `cat docs/guide.md AGENTS.md` or `sed -n '1,20p' docs/interpreting-task-prompts.md`.

Example: given shell commands `cat docs/guide.md AGENTS.md` and `sed -n '1,5p' ./docs/extra.md`, the helper should return `["AGENTS.md", "docs/extra.md", "docs/guide.md"]` after path normalization.

## `computeGroundTruthDiff(feature)` — `src/eval-helpers.ts`

Converts `CarvedFeature.operations` + `originalFiles` into a unified diff showing what the agent needs to recreate.

**Gotcha:** `originalFiles` only contains pre-carve contents of `candidate.files` from the planner. Shared files edited during carve cleanup can appear in `operations` without appearing in `originalFiles`. If a carve deletes `src/feature.ts` and edits `src/index.ts`, using only `originalFiles` may drop the `src/index.ts` hunk from judge input. When possible, pass the actual reference diff as an explicit argument to judging rather than reconstructing it.

## Git Diff Capture

When capturing diffs from the source repo (e.g., docs-only flows):

- **Never call `git add .` on the source repository** — this mutates the index
- Build the pathspec from only the allowed files that actually exist (e.g., `docs/`, `AGENTS.md`, `CLAUDE.md` after checking existence)
- Missing optional files (like `CLAUDE.md`) must not make the whole diff capture fail
- Unrelated source files must remain unstaged
- If a runner abstraction exists (e.g., `ClaudeRunner` in `src/runners/claude.ts`), prefer it over open-coding another SDK loop
