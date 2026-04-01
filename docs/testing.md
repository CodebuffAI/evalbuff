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

Expensive or paid flows must run inside one explicit `it.skipIf(SKIP)(...)` block with a long timeout. Do not put live API work in `beforeAll`/`afterAll` — Bun reports a single unnamed hook failure and artifact assertions never execute.

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

- Capture that directory with a failure-safe helper and always clean it in `finally`, even when the orchestrator throws before assertions run
- Never scan global tmp to find "the newest" run directory — this is unsafe under concurrent runs because the test can pick up another run's artifacts

### Nullable Agent Returns

Live agent calls (e.g., `carveFeature()`) can genuinely return `null` due to model non-determinism. Tests should:

- Call multiple candidates and collect results, allowing individual candidates to fail
- Use a success criterion like "at least one candidate produced a valid result" rather than "every candidate succeeded"
- Log skipped/null candidates for debugging rather than asserting they all pass

## CLI Command Testing

Every new standalone command needs local coverage for both argument validation and a non-network happy path:

- Keep the CLI thin and test by setting `process.argv`, mocking heavy modules with `mock.module(...)`, then dynamically importing the CLI entrypoint
- Required assertions: missing required flags, invalid repo paths, non-git repos, output file creation, expected JSON fields
- Live-agent E2E tests are additional coverage, not the only coverage
- A CLI change is incomplete unless three artifacts land together: the runnable file in `src/`, a matching `package.json` script (if applicable), and README/docs usage with the exact flag spellings and defaults
- Validate `--repo` in order: path exists → path is a git work tree (`git rev-parse --show-toplevel`) → numeric flags parse cleanly. This prevents low-level provider errors from leaking to users

### Scope Control for Test Tasks

When adding a new test suite, keep the diff limited to the new test file and truly required support changes:

- Do not edit neighboring fixture files or other E2E test repos
- Do not regenerate `bun.lock` unless `package.json` changed in the same diff
- Pre-submit checklist for test-only tasks: `git diff --stat`, `bun install --frozen-lockfile`, `bun run typecheck`, the focused new test, and `bun run test:all`

## Key Contracts Worth Testing

### Docs Syncing
Use disposable git repos to verify:
- Modified `docs/*.md` files are copied
- New docs are copied
- Deleted docs are removed from the target repo
- `AGENTS.md` and `CLAUDE.md` are mirrored like `docs/` files
- Target repo ends with no stale docs after sync
- Commit message is `evalbuff: pre-load docs` and `git status --short` is clean

### Diff Capture
- `captureGitDiff()` uses explicit `baseRef`, not `HEAD`
- Includes tracked edits, staged edits, committed edits since base, and untracked files
- `git diff HEAD` is insufficient after an agent-created commit (returns empty even though `git diff <baseSha>` shows real work)
- No `git add .` side effects

### Judge/Reviewer Validation
- Strict parse of a fully valid result file
- Salvage of partial JSON when one score field is missing but `overallScore` is present
- Missing arrays defaulting to `[]`
- Invalid/non-object result returning `null`
- Prompt includes the exact result-file path

### Report Generation
Deterministic local test (no API keys needed):
- Construct synthetic `RoundResult[]` with at least one successful task, one failed task (`score = -1`), one improvement loop with `judgeSuggestions` and `docsDiff`, and a `finalDocsState` object
- Assert output contains: `## Overview`, `## Score Trajectory`, `## Scores by Round`, `## Final Documentation State`, loop artifact headings, `FAIL`/`FAILED` rendering

### Runner Adapter
For any new runner, test with a mocked SDK client plus a temp git repo:
- Internal events (e.g., `set_messages`) are filtered
- Provider-native tool names are normalized to canonical names (`shell`, `read_file`, `file_change`)
- `extractDocsRead()` recovers docs from normalized steps
- `totalCostUsd` is derived from provider session metadata
- Diff capture includes all edit types
- Failure paths: thrown exceptions and provider-reported failures both write a structured JSON dump containing `prompt`, `steps`, and serialized `error` fields, and cause `run()` to reject without crashing the process

### Infrastructure Failures
- `runAgentOnCarve()` converts clone/setup failures into `score = -1` results instead of throwing
- Temp directories are always cleaned up in `finally`
- Source repos are not left with staging side effects

### Artifact Field Propagation
When adding a new field to a shared interface (e.g., `docsRead` on `TaskResult`):
- Update the interface definition
- Update every constructor and fallback that returns that type, including infra-failure paths
- Update every persistence path (artifact files, `saveRoundResults()`, `saveSummary()`)
- Update every rendering path (markdown report sections)
- Write a deterministic local test that builds synthetic data, calls the persistence helpers, and asserts the field appears in all saved artifacts and report output

### Result File Parsing
For agent-produced JSON files (`evalbuff-carve-result.json`, `evalbuff-review-result.json`):
- Valid file → parsed JSON returned
- Missing file → fallback to parsing `finalResponse` text
- Invalid/corrupt file → fallback to parsing `finalResponse` text
- Cleanup failure → must not override a successful parse (separate parse from cleanup in the `finally` flow)
- Temp file removed in both success and fallback cases
- Test with a stubbed agent client, not only live-agent E2E

### Bootstrap / Init Script Integration
Shell-based setup helpers (e.g., `setup.sh`) need disposable-git integration coverage:
- Run the helper in a cloned checkout and assert environment files are copied
- Run the helper in a `git worktree add` checkout and assert it discovers the primary worktree (not `origin`)
- Assert the documented invocation (`bash setup.sh`) succeeds from checkout root
- Stub heavy commands (e.g., `bun`) via `PATH` with a tiny script that logs arguments to avoid network access

## Carve Compatibility Tests

For helper-style rebuild tasks, verify the exact public API from the ground truth diff before adding broader tests:
- Import the exact module path from the diff
- Assert exported symbol names match
- Assert top-level field names on returned objects
- Run: `bun install --frozen-lockfile`, `bun run typecheck`, focused test, repo-level test suite
