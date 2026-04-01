# Testing

Tests live in `src/__tests__/`.

## Scripts

```bash
bun run test               # Fast regression (trace-compressor only)
bun run test:all           # Everything under src/__tests__/
bun run test:e2e           # Live-agent E2E suites only (*.e2e.test.ts)
bun run typecheck          # Type checking
bun test src/__tests__/<file>.test.ts   # Run a specific test file
```

### Script Truth Rule

Every command documented here and in `AGENTS.md` must exist in `package.json` exactly as written. Before documenting a new script, run `bun run <script>` to verify. If adding a new test suite, use `bun test src/__tests__/<file>` directly rather than inventing undeclared script names.

## Test Tiers

### Unit Tests
Pure helpers, narrow contracts. No filesystem or network.

### Integration Tests
Real filesystem and git operations, but no paid APIs. Use temporary git repos to verify behavior.

### E2E Tests
Live planner/carver/runner/judge flows with real API calls.

## Live-Agent E2E Pattern

Expensive or paid flows must run inside one explicit `it.skipIf(SKIP)(...)` block with a long timeout. Do not put live API work in `beforeAll`/`afterAll` — Bun reports provider failures as `(unnamed)` hook errors and skips the real assertions.

```ts
const SKIP = !process.env.OPENAI_API_KEY ||
  !(process.env.CLAUDE_CODE_KEY || process.env.ANTHROPIC_API_KEY)

it.skipIf(SKIP)('runs full pipeline', async () => {
  let repoDir = ''
  let logDir = ''
  try {
    repoDir = createTestRepo()
    logDir = await captureRunDir(() =>
      runEvalbuff({ repoPath: repoDir, n: 1, parallelism: 1, loops: 1, codingModel: 'sonnet', docsModel: 'sonnet' })
    )
    expect(fs.existsSync(path.join(logDir, 'summary.json'))).toBeTrue()
  } finally {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true })
    if (logDir) fs.rmSync(logDir, { recursive: true, force: true })
  }
}, 90 * 60_000)
```

Limit `beforeAll`/`afterAll` to cheap fixture setup and cleanup.

### Temp Directory Safety

The orchestrator creates its log directory in `os.tmpdir()` as `evalbuff-run-<ISO timestamp>`, not inside the source repo. Tests that assert on artifacts must:

- Capture the exact `logDir` for the current `runEvalbuff()` invocation deterministically (e.g., via a wrapper or return value) and always clean it in `finally`, even when the orchestrator throws before assertions run
- **Never scan `os.tmpdir()` for the newest `evalbuff-run-*` directory** — concurrent runs can create multiple matching directories and a test can silently assert against another run's artifacts
- Mocked `runEvalbuff()` tests must capture the log directory from `os.tmpdir()` because the orchestrator does not write logs inside the source repo

### Nullable Agent Returns

Live agent calls (e.g., `carveFeature()`) can genuinely return `null` due to model non-determinism. Tests should:

- Call multiple candidates and collect results, allowing individual candidates to fail
- Use a success criterion like "at least one candidate produced a valid result" rather than "every candidate succeeded"
- Log skipped/null candidates for debugging rather than asserting they all pass

## CLI Command Testing

Every new standalone command needs local coverage for both argument validation and a non-network happy path:

- Keep the CLI thin and test by setting `process.argv`, mocking heavy modules with `mock.module(...)`, then dynamically importing the CLI entrypoint
- Required smoke tests: `--help`, missing `--repo`, `--n 0`, `--parallelism 0`, `--loops -1`, and `--repo <non-git-dir>`
- A bad repo must fail with a local validation error; it must not start Codex/Claude, create `evalbuff-run-*` directories, or write any repo artifacts during validation failure
- Live-agent E2E tests are additional coverage, not the only coverage
- A CLI change is incomplete unless three artifacts land together: the runnable file in `src/`, a matching `package.json` script (if applicable), and README/docs usage with the exact flag spellings and defaults
- Validate `--repo` in order: `fs.existsSync(repoPath)` → confirm it is a directory → `git rev-parse --show-toplevel` succeeds inside that path → numeric flags parse cleanly. If any check fails, print a short user-facing error and exit 1. Do not let provider startup leak stack traces for bad local input.

### Output File Persistence

If a CLI command promises a JSON artifact (e.g., `carveFeatures()` writing an output file), it must still write the output file for empty results. Do not return early before the write step. Cover both the case where the planner returns zero candidates and the case where every carve returns `null` — expected behavior is to create the output file with a stable envelope object and exit successfully.

### Scope Control for Test Tasks

When adding a new test suite, keep the diff limited to the new test file and truly required support changes:

- Do not edit neighboring fixture files or other E2E test repos
- Do not regenerate `bun.lock` unless `package.json` changed in the same diff. If `bun install --frozen-lockfile` passes, that is verification only and not a reason to restage the lockfile
- Pre-submit check: `git diff --cached --stat` plus `git diff --cached -- package.json bun.lock`. If `bun.lock` appears without a manifest change, treat it as unrelated churn that must be removed
- Pre-submit checklist for test-only tasks: `git diff --stat`, `bun install --frozen-lockfile`, `bun run typecheck`, the focused new test, and `bun run test:all`

## Key Contracts Worth Testing

### Docs Syncing
Use disposable git repos to verify:
- Modified `docs/*.md` files are updated
- New docs are copied
- Deleted docs are removed from the target repo
- Empty `docs/` subdirectories are cleaned up
- `AGENTS.md` and `CLAUDE.md` are mirrored like `docs/` files
- Target repo ends with no stale docs after sync
- `git log -1 --pretty=%s` equals `evalbuff: pre-load docs` and `git status --short` is empty
- `syncDocsIntoRepo()` alone does not create any commit and does not stage or commit unrelated files (e.g. an unrelated modified `notes.txt` in the target)

### Diff Capture
- `captureGitDiff()` uses explicit `baseRef`, not `HEAD`
- Includes tracked edits, staged edits, committed edits since base, and untracked files
- `git diff HEAD` is insufficient after an agent-created commit (returns empty even though `git diff <baseSha>` shows real work)
- Must be side-effect free: create a temp repo with one staged modification and one untracked file, call the helper, assert the returned diff contains both changes, then assert `git diff --cached` still shows the original staged change and `git status --short` is unchanged

### Judge/Reviewer Validation
Use `mock.module('@openai/codex-sdk', ...)` before importing `src/judge.ts` with a temp `repoDir`:
- Reviewer writes a fully valid `evalbuff-review-result.json` → parsed result returned
- Reviewer writes partial JSON containing only `overallScore` → salvage fills `completionScore`/`codeQualityScore`/`e2eScore` from `overallScore`
- Missing arrays default to `[]`
- Reviewer writes no file → `judgeTaskResult()` falls back to JSON parsed from `finalResponse`
- Invalid/non-object result returning `null`
- Prompt includes the exact result-file path
- Temp result file is deleted after parsing in both success and fallback cases

### Report Generation
Deterministic local test (no API keys needed):
- Construct synthetic `RoundResult[]` with at least one successful task, one failed task (`score = -1`), one improvement loop with `judge-suggestions-loop-1.txt`, `docs-diff-loop-1.txt`, and `docs-state-loop-1.json`
- Call the real report helpers and assert the exact artifacts exist: `${logDir}/summary.json`, `${logDir}/report.md`, plus `round-<n>/<featureId>/trace.txt`, `diff.txt`, `judging.json`, and `score.txt`
- Assert the report contains these exact headings: `## Overview`, `## Score Trajectory`, `## Scores by Round`, `## Final Documentation State`, `### Judge Suggestions Applied (Loop 1)`, `### Docs Changes (Loop 1)`
- Assert both `FAIL` and `FAILED` renderings appear for failed tasks
- Report tasks are contract-preserving: do not rename artifact files or replace `saveSummary()` with a new API unless every caller, test, and doc is updated in the same diff

### Runner Adapter
For any new runner, require a checked-in integration test that mocks the provider SDK and uses a temp git repo. Assert:
- Internal events (e.g., `set_messages`) are filtered
- Provider-native tool names are normalized to canonical names (`shell`, `Read`/`read_file`, `file_change`)
- Input-shape normalization for read tools (e.g., `paths: string[]` → one step per path with `input.path`)
- `extractDocsRead()` recovers docs from the normalized steps
- `totalCostUsd` is derived from provider session metadata
- Diff capture via `captureGitDiff()` from a recorded base SHA
- Structured JSON dump contents for both thrown exceptions and provider-reported failures
- Failure paths: thrown exceptions and provider-reported failures both cause `run()` to reject without crashing the process

### Infrastructure Failures
- `runAgentOnCarve()` converts clone/setup failures into `score = -1` results instead of throwing
- Temp directories are always cleaned up in `finally`
- Source repos are not left with staging side effects

### Artifact Field Propagation
When adding a new field to a shared interface (e.g., `docsRead` on `TaskResult`):
- Update the interface definition
- Update every constructor and fallback that returns that type, including infra-failure paths (`createInfrastructureFailureResult()`)
- Update every persistence path (artifact files, `saveRoundResults()`, `saveSummary()`)
- Update every rendering path (markdown report sections)
- Write a deterministic local test that builds synthetic data, calls the persistence helpers, and asserts the field appears in all saved artifacts and report output

The current artifact contract per task is: `trace.txt`, `diff.txt`, `judging.json`, `score.txt`. Loop artifacts are `judge-suggestions-loop-<n>.txt`, `docs-diff-loop-<n>.txt`, `docs-state-loop-<n>.json`. Report headings are `## Score Trajectory` and `## Scores by Round`. Failed tasks render as `FAIL`/`FAILED`. Tests should assert these exact paths and headings.

### Result File Parsing
For agent-produced JSON files (`evalbuff-carve-result.json`, `evalbuff-review-result.json`):
- Valid file → parsed JSON returned
- Missing file → fallback to parsing `finalResponse` text
- Invalid/corrupt file → fallback to parsing `finalResponse` text
- Cleanup failure → must not override a successful parse (separate parse from cleanup in the `finally` flow)
- Temp file removed in both success and fallback cases
- Test with a stubbed agent client, not only live-agent E2E
- For `planFeatures(repoPath)`: test a same-repo rerun case where the first call leaves a file behind. Assert `fs.existsSync(path.join(repoPath, 'evalbuff-carve-result.json'))` is false after every successful call and that the second call does not reuse stale data from the first

### Bootstrap / Init Script Integration
Shell-based setup helpers (e.g., `setup.sh`) need disposable-git integration coverage:
- Run the helper in both a `git worktree add` checkout and a `git clone --no-checkout` checkout
- Assert the documented invocation (`bash setup.sh`) succeeds from checkout root
- Assert the helper does not rely on source-worktree-only metadata when running in a plain clone (because the eval runner uses `git clone`, not `git worktree add`)
- Stub heavy commands (e.g., `bun`) via `PATH` with a tiny script that logs arguments to avoid network access
- Assert the install command matches the intended contract exactly

### Trace Compressor
Required focused tests:
- JSONL `tool_result` extraction above threshold
- Plain-text traces with surrounding context preserved before and after a large fenced/XML block
- Multiple sidecars in one trace
- Summaries containing double quotes and JSON-like snippets
- Real filesystem integration path through `saveRoundResults()` in `src/report.ts`
- Round-trip requirement: `restoreTrace(compressTrace(raw).compressed, sidecarDir)` must reproduce the original trace byte-for-byte
- `trace.txt.compressed` must still contain the neighboring inline text; sidecar files must exist in `trace.txt.sidecars/`

## Carve Compatibility Tests

For helper-style rebuild tasks, verify the exact public API from the ground truth diff before adding broader tests:
- Import the exact module path from the diff
- Assert exported symbol names match
- Assert top-level field names on returned objects
- Run: `bun install --frozen-lockfile`, `bun run typecheck`, focused test, repo-level test suite
- For single-helper tasks, `git diff --cached --name-only` should normally show only the helper file and its focused test; if `package.json` is unchanged, `bun.lock` must not be staged
