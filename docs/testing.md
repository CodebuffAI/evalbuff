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
  const repoDir = createTestRepo()
  await runEvalbuff({ repoPath: repoDir, n: 1, parallelism: 1, loops: 1, codingModel: 'sonnet', docsModel: 'sonnet' })
  const logDir = findNewRunDir()
  expect(fs.existsSync(path.join(logDir, 'summary.json'))).toBeTrue()
}, 90 * 60_000)
```

Limit `beforeAll`/`afterAll` to cheap fixture setup and cleanup.

## CLI Command Testing

Every new standalone command needs local coverage for both argument validation and a non-network happy path:

- Keep the CLI thin and test by setting `process.argv`, mocking heavy modules with `mock.module(...)`, then dynamically importing the CLI entrypoint
- Required assertions: missing required flags, invalid repo paths, non-git repos, output file creation, expected JSON fields
- Live-agent E2E tests are additional coverage, not the only coverage

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
- Provider-native tool names are normalized to canonical names
- `extractDocsRead()` recovers docs from captured steps
- `totalCostUsd` is derived from provider session metadata
- Diff capture includes all edit types
- Failure paths write structured JSON dumps without throwing

### Infrastructure Failures
- `runAgentOnCarve()` converts clone/setup failures into `score = -1` results instead of throwing
- Temp directories are always cleaned up in `finally`
- Source repos are not left with staging side effects

## Carve Compatibility Tests

For helper-style rebuild tasks, verify the exact public API from the ground truth diff before adding broader tests:
- Import the exact module path from the diff
- Assert exported symbol names match
- Assert top-level field names on returned objects
- Run: `bun install --frozen-lockfile`, `bun run typecheck`, focused test, repo-level test suite
