# Evaluation Workflow

The evalbuff pipeline is:

1. Plan carve candidates from the repo (Codex)
2. Carve a subset into evaluation tasks (Codex in git worktrees)
3. Rebuild each carved feature in isolated temp repos (Claude Code)
4. Judge the result with E2E-oriented review (Codex)
5. Refactor docs based on judge suggestions and repeat

## Entry Points

- `runEvalbuff(opts)` in `src/run-evalbuff.ts` orchestrates the full loop
- `runAgentOnCarve(opts)` in `src/eval-runner.ts` evaluates one carved feature

```ts
interface EvalbuffOptions {
  repoPath: string
  n: number            // features to randomly select
  parallelism: number  // concurrent agent runs per round
  loops: number        // improvement iterations (default 3)
  initCommand?: string
  codingModel: string  // default: 'sonnet'
  docsModel: string    // default: 'opus'
}
```

## Pipeline Phases

### Phase 1: Planning

`planFeatures(repoPath)` uses Codex to analyze the codebase and identify 15-25 discrete, carve-able features. The agent writes results to `evalbuff-carve-result.json` in the repo; if the file is missing, the pipeline falls back to parsing JSON from the agent's response text.

### Phase 2: Carving

`carveFeature(repoPath, candidate)` creates a git worktree, runs a Codex agent to surgically remove the feature, captures the real `git diff` as ground truth, and builds `FileOperation[]` from the diff. The worktree and branch are cleaned up in `finally`.

### Phase 3: Baseline Evaluation (Round 0)

`runAgentOnCarve()` for each feature:
1. Clone source repo to temp directory
2. Checkout HEAD, apply carve operations (remove the feature)
3. Commit carved state
4. `copyDocsIntoRepo()` — sync latest working-tree docs and commit them
5. Run init command (if specified)
6. Run coding agent (Claude Code) to rebuild the feature
7. Judge with Codex reviewer
8. Return `TaskResult`

On infrastructure failure at any step → `TaskResult` with `score = -1`.

### Phase 4: Improvement Loops (Rounds 1..N)

For each loop:
1. `collectDocSuggestions(tasks)` aggregates `docSuggestions` from judge results with feature context
2. `runDocsRefactorAgent()` runs Claude in a temp clone to edit docs holistically
3. Updated docs are synced back to the source repo's working tree (no auto-commit)
4. Re-evaluation runs with the updated docs

### Phase 5: Summary

`saveSummary()` writes `summary.json` and `report.md` to the log directory.

## Ground Truth Diff Contract

Every `CarvedFeature` persists both `originalFiles: Record<string, string>` and `diff: string`. Judging must use `getGroundTruthDiff(feature)` from `src/eval-helpers.ts`:

```ts
const groundTruthDiff = feature.diff.trim() ? feature.diff : computeGroundTruthDiff(feature)
```

Always prefer `feature.diff` — it captures shared-file cleanup edits that may not be recoverable from `originalFiles` alone. The reconstruction fallback exists only for legacy data.

`getGroundTruthDiff(feature)` returns the patch from the carved repo back to the original implementation: deleted feature files become additions with `--- /dev/null` and `+++ b/<path>`, and modified files use carved content as removed lines and original content as added lines. **Never pass the carve-removal diff to the judge** — pass the reconstruction diff.

Wiring pattern in the orchestrator — every eval round must precompute ground truth diffs:

```ts
const groundTruthDiffs = new Map(features.map(f => [f.id, getGroundTruthDiff(f)]))
// ... passed to runAgentOnCarve which forwards to judgeTaskResult
judgeTaskResult({ taskPrompt, agentDiff, groundTruthDiff: groundTruthDiffs.get(feature.id) || '', repoDir })
```

## Judge Contract

Judging is implemented in `src/judge.ts` as a dedicated module. `buildReviewerPrompt()` is part of the public contract — changes to it affect the reliability of reviewer output.

The reviewer prompt must:
- Instruct the reviewer to read `docs/` and `AGENTS.md` when present
- Run real verification commands from repo root (build, test, curl, etc.)
- Write `evalbuff-review-result.json` as its final action
- Produce `docSuggestions` strings that include the target doc path plus substantive content (function names, signatures, examples, gotchas)

### Schema

```ts
export const JudgingResultSchema = z.object({
  analysis: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  e2eTestsPerformed: z.array(z.string()),
  completionScore: z.number().min(0).max(10),
  codeQualityScore: z.number().min(0).max(10),
  e2eScore: z.number().min(0).max(10),
  overallScore: z.number().min(0).max(10),
  docSuggestions: z.array(z.string()).optional(),
})
```

### API

```ts
export async function judgeTaskResult(input: {
  taskPrompt: string
  agentDiff: string
  groundTruthDiff?: string
  repoDir: string
  error?: string
}): Promise<JudgingResult>
```

### Behavior

- The reviewer agent writes JSON to `evalbuff-review-result.json` in `repoDir`
- After the run, the judge reads and validates the file with Zod
- On validation failure: `salvagePartialResult()` recovers best-effort results when `overallScore` is present. Salvage rule: if `overallScore` exists but `completionScore`, `codeQualityScore`, or `e2eScore` are missing, those missing fields default to `overallScore` (not `0`). Missing arrays default to `[]`.
- On complete failure: returns fallback all-zero `JudgingResult`
- The reviewer runs in the repo checkout containing the agent's code changes — launching it in an empty directory is invalid for E2E testing
- `docSuggestions` are actionable documentation edits (distinct from `weaknesses`) stored on every `TaskResult.judging` object

### Doc Suggestions Flow

`docSuggestions` flow through the pipeline as:

1. Judge writes them per-task in `JudgingResult`
2. `collectDocSuggestions(tasks)` aggregates `docSuggestions` (not `weaknesses`) from judge results, ignoring failed tasks. Format: `### feature-id (score: 4.0/10)` + bullet suggestions
3. `runDocsRefactorAgent(repoPath, judgeSuggestions, model)` receives the aggregated text and edits docs holistically using `docsModel`

## Init Commands

`runAgentOnCarve()` runs `execSync(initCommand, { cwd: repoDir, stdio: 'ignore', timeout: 120000 })` after cloning and checking out HEAD.

- Scripts must be committed in the repo and invokable relative to repo root
- The init command runs in a fresh `git clone --no-checkout` checkout, **not** inside the original source repo or a sibling `git worktree add` checkout
- `git worktree list` inside that clone only sees the clone itself — bootstrap helpers cannot discover the source worktree or its untracked files (e.g. `.env.local`) that way
- Bootstrap helpers must rely on files present in the cloned checkout, explicit command arguments, or environment variables passed into the process — not implicit source worktree discovery
- Example: `--init-command "bash setup.sh"`

## Docs Refactor Loop

`runDocsRefactorAgent()` in `src/docs-refactor.ts`:

1. Clones the source repo to a temp directory at HEAD
2. Syncs the latest working-tree docs into the clone (picks up uncommitted edits)
3. Runs Claude agent with judge suggestions
4. Syncs only `docs/**/*.md`, `AGENTS.md`, `CLAUDE.md` back to the source repo
5. Does NOT auto-commit the source repo — changes persist as working-tree modifications

The next eval round picks up these uncommitted docs via `copyDocsIntoRepo(docsSourcePath, repoDir)`, which reads from the filesystem (not git).

## Result File Pattern

Both the planner/carver (`evalbuff-carve-result.json`) and judge (`evalbuff-review-result.json`) use the same pattern for agent-produced JSON:

1. Agent is instructed to write a JSON file at a known path in `repoDir`
2. After the run, attempt to read and parse the file
3. Store the parsed value in a local variable, then **always** delete the file in a `finally` block with `fs.rmSync(resultPath, { force: true })`
4. Only then `return parsed` or fall back to response text
5. When parsing prose that may wrap JSON, extract the JSON object (e.g., regex for `{...}` containing expected keys), don't slice to the last `}`

**Critical**: file parsing and cleanup must be separated so cleanup failure never discards a successfully parsed result:

```ts
let parsed: T | null = null
if (fs.existsSync(resultPath)) {
  try {
    parsed = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as T
  } catch (err) {
    console.warn('Parse failed, will fall back to response text')
  } finally {
    fs.rmSync(resultPath, { force: true })
  }
  if (parsed) return parsed
}
// Fall back to parsing finalResponse
```

Do not use `unlinkSync()` inside the parse `try` — an unlink error can incorrectly turn a valid file into a failed run.

**Repeated-run gotcha**: `planFeatures(repoPath)` may be called multiple times against the same repository during tests or orchestration. Leaving `evalbuff-carve-result.json` behind causes later runs to return stale plans and defeats the fallback path. Always clean up result files regardless of success or failure.

## Run Report Contract

`src/report.ts` exports:
- `saveRoundResults(logDir: string, roundResult: RoundResult): void` — writes per-task artifacts
- `saveSummary(logDir: string, summary: EvalSummary, roundResults: RoundResult[], opts: EvalOptions): void` — writes both `${logDir}/summary.json` and `${logDir}/report.md`

Report sections in order:
1. `## Overview` — config table (includes `Improvement loops`, `Coding model`, `Docs model`)
2. `## Score Trajectory` — bar chart
3. `## Scores by Round` — features × rounds table (shows `FAIL` for `score < 0`)
4. `## <Round> — Detail` — per-task breakdown with score table, analysis, strengths/weaknesses, E2E tests, docs read, doc suggestions
5. `### Judge Suggestions Applied (Loop N)` — for non-baseline rounds
6. `### Docs Changes (Loop N)` — for non-baseline rounds
7. `## Final Documentation State` — full markdown of final docs

Failed tasks render `### featureId — FAILED` with a quoted failure summary; no numeric score table.

### Artifacts by Round

```
round-<n>/
  summary.json
  <featureId>/
    trace.txt              # Canonical raw trace — NEVER overwritten
    trace.txt.compressed   # Sidecar refs inline (derived, additive)
    trace.txt.sidecars/    # Directory of extracted blocks
      manifest.json        # Index of all sidecars
      sidecar_<id>.json    # or .txt — individual extracted blocks
    diff.txt               # Agent's diff
    judging.json           # Full JudgingResult
    score.txt              # Numeric score
judge-suggestions-loop-<n>.txt
docs-diff-loop-<n>.txt
docs-state-loop-<n>.json
```

### Additive Artifact Pattern

When any pipeline step produces derived artifacts from a raw artifact, the raw artifact must remain **byte-for-byte identical** to its original content. Derived artifacts use sibling naming conventions:

- `<source>.<suffix>` for the processed version (e.g., `trace.txt.compressed`)
- `<source>.<suffix>/` for a directory of supporting files (e.g., `trace.txt.sidecars/`)

**Rules**:
1. Write the raw artifact first, then derive
2. Never overwrite the source file with processed output
3. Never write derived metadata (e.g., `manifest.json`) next to the raw file — it goes inside the derived directory
4. Never use a generic per-task directory name (e.g., `sidecars/`) — use `<source>.sidecars/`

### `saveRoundResults()` Integration Wiring

The exact integration pattern in `src/report.ts` is:

```ts
const tracePath = path.join(taskDir, 'trace.txt')
fs.writeFileSync(tracePath, task.trace)                       // 1. Write raw artifact
compressAndSave(tracePath, task.trace).catch((err) => {       // 2. Derive in background
  console.warn(`Failed to compress trace for ${task.featureId}: ${err}`)
})
```

Key points:
- `compressAndSave()` is fire-and-forget (`.catch()` only logs)
- The raw `trace.txt` is never touched again after the initial write
- Derived artifacts appear as `trace.txt.compressed` and `trace.txt.sidecars/manifest.json`

**Verification recipe**: Construct a synthetic `RoundResult` with a trace payload exceeding 2048 bytes (the default threshold), call `saveRoundResults()`, wait briefly for background compression, then assert:
1. `trace.txt` is byte-for-byte equal to `task.trace`
2. `trace.txt.compressed` exists
3. `trace.txt.sidecars/manifest.json` exists

## TaskResult

```ts
interface TaskResult {
  featureId: string
  prompt: string
  score: number        // 0-10 or -1 for infrastructure failure
  diff: string
  trace: string
  judging: JudgingResult
  costEstimate: number
  docsRead: string[]   // Extracted from agent trace by extractDocsRead()
}
```

## Runner Selection

Currently, `runAgentOnCarve()` in `src/eval-runner.ts` only instantiates `ClaudeRunner`. To add a new runner, you must wire it into the runner selection logic there — exporting from `src/runners/index.ts` alone is not sufficient.
