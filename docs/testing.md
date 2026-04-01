# Testing Conventions

Tests use [Bun test](https://bun.sh/docs/cli/test) and live in `src/__tests__/`.

## Test Tiers

| Tier | Description | Mocking | Example |
|---|---|---|---|
| **Unit** | Pure functions, no I/O | Mock freely | `trace-compressor.test.ts` |
| **Integration** | Real I/O, no paid APIs | Filesystem + git only | Carve fixture tests |
| **E2E** | Full pipeline with live agents | No mocking of core pipeline | `run-evalbuff.e2e.test.ts` |

**E2E means real execution**: `planFeatures()`, `carveFeature()`, `runAgentOnCarve()`, and `runDocsRefactorAgent()` should not be mocked in E2E tests. If credentials are unavailable, skip:

```typescript
const SKIP = !process.env.OPENAI_API_KEY || !(process.env.CLAUDE_CODE_KEY || process.env.ANTHROPIC_API_KEY)
it.skipIf(SKIP)('runs full pipeline', async () => { ... }, 10 * 60_000)
```

## Bun-Specific Gotchas

### Timeouts for Live Agent Calls

**Put expensive work inside `it(...)`, not `beforeAll`/`afterAll`.** Bun hook timeouts default to ~5 seconds and will kill the suite before an API call finishes. Pass explicit timeouts as the third argument to `it()`:

```typescript
it('runs planner', async () => {
  const plan = await planFeatures(repoPath)
  expect(plan.candidates.length).toBeGreaterThan(0)
}, 10 * 60_000)  // 10 minute timeout
```

### Guard Secret-Dependent Tests

```typescript
const SKIP = !process.env.OPENAI_API_KEY
it.skipIf(SKIP)('calls live API', async () => { ... })
```

Return early from hooks when `SKIP` is true to avoid setup errors.

## Carve Fixture Conventions

Planner/carver E2E fixtures should be committed synthetic repos with:

- Deterministic contents (no randomness)
- Explicit git identity so `git commit` works in CI:
  ```typescript
  execSync('git config user.email "test@evalbuff.test"', { cwd: repoDir })
  execSync('git config user.name "Test"', { cwd: repoDir })
  ```

### Minimum Assertions for Carve Tests

1. Planner returns structured candidates with `id`, `name`, `prompt`, `description`, `files`, `relevantFiles`, `complexity`
2. Each carved feature yields a non-empty git diff plus `operations`
3. `originalFiles[path]` matches the committed on-disk content from the main repo
4. `git status --porcelain` in the main repo is empty after carving
5. `git worktree list` shows only the primary worktree

If a test claims a threshold (e.g., "all referenced files exist"), the assertion must enforce that exact threshold.

## Test Scope

Prefer one focused test per requested behavior before adding optional extras. Mirror the externally observable contract, not incidental implementation details.

For filesystem-producing helpers like `compressTrace(rawTrace, traceDir)`:
- Assert outcomes: "a file was created", "large content moved out of inline output", "cleanup removes the directory"
- Avoid hard-coding temp filenames like `result-000.txt` or exact summary strings unless those are documented invariants
- Use `fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-'))` for temp dirs, assert on `fs.readdirSync(dir).length`, clean up in `afterEach`

## Dependency Management

This repo maintains both `package-lock.json` and `bun.lock`. Any dependency edit in `package.json` must update both lockfiles in the same change.

Verification checklist:
1. Compare `package.json` dependencies with `package-lock.json`
2. Regenerate `bun.lock`
3. Run the frozen install path
4. Run `bun test` and `tsc --noEmit -p .`

If a package is added only to `package.json`, clean installs and eval runs break.
