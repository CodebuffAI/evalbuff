# Testing

## Commands

```bash
bun run typecheck          # TypeScript strict check
bun run test               # Unit tests only (excludes *.e2e.test.ts)
bun run test:all           # All tests including E2E
bun run test:e2e           # E2E tests only
```

**`bun run test` vs `bun test`**: `bun run test` is the unit-test entrypoint because it applies the repo's `--path-ignore-patterns '**/*.e2e.test.ts'` filter. Bare `bun test` executes all discovered tests and may run live-model E2E cases when provider environment variables are present. Use `bun run typecheck && bun run test` for local verification of ordinary code changes. Reserve `bun test` or `bun run test:all` for environments where network access and provider credentials are intentionally available.

**Verification workflow**: For code changes, run in this order: (1) `bun test src/__tests__/<module>.test.ts` for the changed area, (2) `bun run typecheck`, (3) `bun run test` for all unit tests, (4) optionally `bun test` for live-model E2E coverage. Provider/network failures in step 4 should be reported separately from patch regressions, with the exact failing file and provider error message.

## Prerequisites

Fresh workspaces (e.g., carved eval repos) may not have dependencies installed. Always run `bun install` or `bash setup.sh` before expecting `bun run typecheck` or `bun test` to succeed. A task is not complete until both commands pass after dependencies are installed.

Local developer credentials can live in `.env.local`. `bunfig.toml` preloads `src/load-env.ts`, so direct Bun invocations such as `bun test src/__tests__/docs-writer.e2e.test.ts` and `bun run src/run-evalbuff.ts ...` automatically read `.env.local` first, then `.env`, without requiring wrapper scripts.

## Test File Layout

- Unit tests: `src/__tests__/<module>.test.ts`
- E2E tests: `src/__tests__/<module>.e2e.test.ts`

## E2E Test Conventions

E2E tests invoke live model SDKs and must be gated:

```ts
const SKIP = !process.env.OPENAI_API_KEY
it.skipIf(SKIP)('description', async () => { ... })
```

For tests needing both providers:
```ts
const SKIP = !process.env.OPENAI_API_KEY || !(process.env.CLAUDE_CODE_KEY || process.env.ANTHROPIC_API_KEY)
```

API-key gating is necessary but not sufficient. Live SDK tests make real outbound network calls and can fail with transport errors (e.g., stream disconnects). Use multi-minute per-test timeouts, log the temp repo path before the first SDK call, and when reviewing failures distinguish provider transport outages from assertion failures in the test logic.

**Prefer named tests over `beforeAll` for SDK calls**: Place live SDK calls (planning, carving, evaluating, judging) inside named `it.skipIf(...)` tests, not inside `beforeAll()`. Bun reports uncaught `beforeAll` failures as `(unnamed)`, making provider failures hard to diagnose. If shared state is required, declare it at file scope (e.g., `let plan: CarvePlan | undefined`) and populate it in the first named test. If `beforeAll` must call a provider, wrap it in try/catch, log the repo path and phase name, and rethrow with a prefixed message.

## Temporary Git Repos in Tests

Many tests create temporary git repos. Standard pattern:

1. Create a temp dir under `os.tmpdir()`.
2. `git init`, configure `git user.name` and `git user.email`.
3. Write files, `git add`, `git commit`.
4. Run the code under test.
5. Clean up in `afterEach` or a `finally` block — always clean up even when the test throws.

For testing functions that use `git clone`, verify the main repo is clean afterward with `git status --short` and `git worktree list`.

## Mocking SDK-Backed Modules

Modules like `src/runners/claude.ts` and `src/carve-features.ts` import external SDKs at the top level. If the code under test fails before those SDKs are used, register `mock.module()` stubs before a dynamic `await import(...)`:

```ts
import { mock } from 'bun:test'
mock.module('../runners/claude', () => ({
  ClaudeRunner: class { async run() { throw new Error('should not run') } }
}))
const { runAgentOnCarve } = await import('../eval-runner')
```

**Mock scope warning**: `mock.module()` in Bun is process-global for the current test worker and can leak into later test files. Never register top-level mocks for shared modules (e.g., `../carve-features`, `../eval-runner`, `../docs-writer`) in a file that runs alongside other suites unless the whole file is intentionally isolated. Use this pattern only in orchestration/unit tests that dynamically `await import(...)` the subject after installing mocks in the same file. A stray mock can silently cause other test files to receive a fake module instead of the real one.

## Diff Validation

When tests produce diffs, validate both representations:
1. Write the diff to a temp patch file and run `git apply --check` in a fresh clone to verify it applies cleanly.
2. If the code also produces serialized file operations, apply them separately (e.g., via `applyCarveOperations()` from `src/eval-helpers.ts`) and assert deleted files are absent while modified files match `op.newContent`.

This catches cases where patch text looks valid but serialized file operations do not recreate the same filesystem state.

## Infrastructure Failure Testing

`runAgentOnCarve()` must never throw for infrastructure failures — it returns a `TaskResult` with `score: -1`, empty `diff`, `costEstimate: 0`, `trace` starting with `Agent error:`, and all judging scores set to `-1`. Test by calling with a nonexistent `repoPath` so `git clone` fails before the agent runs.

Do not stub the runner to throw the same failure shape — `runAgentOnCarve()` maps both repo-setup exceptions and runner exceptions to the same infrastructure failure result, so a throwing runner mock can hide regressions. Preferred pattern: call with a nonexistent `repoPath` and assert the runner and judge were never called (use spy/counter if needed for verification).

## Runner Verification

Every new runner in `src/runners/` must have at least these test cases in `src/__tests__/<runner>.test.ts`:

1. **Success-path test**: Mock the provider SDK via `mock.module('<sdk>', ...)` before `await import('../runners/<runner>')`. Use a real temp git repo. Assert that `result.steps` contains normalized `tool_call`, `tool_result`, and `text` events, that `result.diff` contains both tracked and untracked changes, and validate the diff with `git apply --check`.
2. **Logical provider failure test**: The SDK resolves normally but the returned result indicates an error (e.g., `output.type: 'error'`). Assert that a debug-trace artifact is written and any partial steps collected during streaming are preserved.
3. **Thrown SDK/transport exception test**: The SDK throws (connection failure, auth error). Assert that the runner rethrows and also writes a debug trace artifact.
4. **Credential precedence test**: Spy on the mocked SDK constructor and verify the effective API key precedence matches the runner's documented order (constructor option → environment variable → fallback).

Cover every provider item/event type the runner claims to support. When a runner discovers provider logs from the filesystem, add a collision test with two temp repos that both end in `repo` to prove it cannot attribute another run's logs.

## Artifact Loader Testing

For any loader that reads evalbuff run directories from disk (e.g., `loadLogDir()` in `src/tui/data.ts`), tests should be black-box tests under `src/__tests__/` that create a temp directory with `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, populate real artifact files, and assert on the public return shape.

Required cases:
- Empty directory returns safe defaults (nulls and empty arrays)
- Malformed JSON files return null without throwing
- Partial `round-N/` directories where `summary.json` is not yet written but feature subdirectories exist
- Gap-stopped round discovery (rounds scanned sequentially, stop at first missing `round-N/`)
- Optional file nullability (`diff.txt`, `trace.txt`, `judging.json` may be absent)
- `reloadLogDir(existing)` observes files written after the first load
- **Loop artifacts before round directories**: Create only `round-0/`, then write `judge-suggestions-loop-1.txt` and `docs-diff-loop-1.txt` without creating `round-1/`. Assert that the loader still exposes loop 1 data, because the orchestrator writes loop files before starting the next evaluation round.
- **Full artifact tree**: Write a complete log tree with `round-N/<featureId>/` task files, `baseline-rejudge-loop-N/`, `summary.json`, and `report.md`, then assert the returned shape covers all drill-down data.

## Event Stream Testing

For tests of event-emitting orchestration, use `mock.module()` before dynamic `await import(...)` to stub pipeline steps (`planFeatures`, `carveFeature`, `runAgentOnCarve`, `runDocsWriterAgent`, etc.), then run the orchestrator against a temp repo/log dir and assert that `events.jsonl` exists, parses as one JSON object per line, and contains the expected ordered sequence.

Include failure-path expectations: carve exceptions should emit `feature_status` with `status: 'carve_failed'`, infrastructure failures should emit `status: 'eval_failed'`, and `events.close()` must flush the file in a `finally` block even when orchestration throws.

## Full Pipeline E2E Tests

A full-pipeline E2E test calls the real orchestrator (e.g., `runEvalbuff()`) without stubbing internal steps like `planFeatures()`, `carveFeature()`, `runAgentOnCarve()`, or `runDocsWriterAgent()`. Gate live runs with appropriate skip conditions:

```ts
const SKIP = !process.env.OPENAI_API_KEY || !(process.env.CLAUDE_CODE_KEY || process.env.ANTHROPIC_API_KEY)
it.skipIf(SKIP)('full pipeline', async () => { ... })
```

Build a temp git repo with at least 2 distinct feature areas and lightweight repo-local tests. Assert the real artifact structure from `docs/run-artifacts.md`: `plan.json`, `features.json`, `round-0/`, subsequent rounds, `baseline-rejudge-loop-N/`, loop artifacts including `doc-gates-loop-N.json`, `summary.json`, `report.md`, and `git worktree list` cleanup. Any change to artifact persistence contracts must be verified by updating these assertions.

## Preserving Failed E2E Runs

Live-model E2E tests must not unconditionally delete `logDir` in `afterAll()`. If the pipeline throws, print the run directory and leave it on disk so `events.jsonl`, partial artifacts, and docs diffs remain available for debugging. Only clean up after a successful test or behind an explicit opt-in environment variable if one is later implemented.

## Helper-Contract Tests

For testing helper functions from `src/eval-helpers.ts`:

- **Docs sync tests**: Seed the target repo with both a stale file under `docs/` and a stale root file (`AGENTS.md` or `CLAUDE.md`) that is absent from the source repo. After sync, assert both stale files are removed, expected source docs are present, `git log -1 --pretty=%s` is `evalbuff: pre-load docs` for `copyDocsIntoRepo()`, and `git status --short` is empty.
- **Diff capture tests**: One required test must create `baseSha = git rev-parse HEAD`, commit a tracked change after that SHA, then leave an untracked file in the working tree and call `captureGitDiff(repo, { baseRef: baseSha })`. Assert that both the committed file path and the untracked file path appear in the **same** returned diff. Separate tests for `baseRef` and untracked files do not satisfy this requirement. Keep a separate `pathspecs` exclusion test as an additional case.
- **Doc reading tests**: Cover `Read`, `read_file`, `read_files`, `shell`, and `run_terminal_command` step types. Include both repo-relative and absolute doc paths in inputs. Assert deduplication and sorted repo-relative output.
- **Test repo utils tests**: Call `withTestRepo` and `withTestRepoAndParent` through their public config-object API. Cover local-clone mode (`localRepoPath`) and remote/fetch mode (`repoUrl`), verify the callback sees the expected checkout, assert cleanup after both success and thrown callbacks, and include edge cases for initial commits and merge commits (both return `null`).
- **Carve post-conditions**: After each successful carve, assert: (1) `feature.originalFiles` contains at least one saved source file, (2) the source repo is clean (`git status --porcelain` is empty), (3) `git worktree list` shows exactly one entry (no leaked worktrees).

## TypeScript Strictness

Strict mode is enabled. Tests must narrow optional union fields before using them in typed matchers (e.g., check `result.judging` is defined before asserting on its properties).
