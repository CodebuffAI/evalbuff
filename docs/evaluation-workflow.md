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

Wiring pattern in the orchestrator:

```ts
const groundTruthDiffs = new Map(features.map(f => [f.id, getGroundTruthDiff(f)]))
// ...
judgeTaskResult({ taskPrompt, agentDiff, groundTruthDiff: groundTruthDiffs.get(feature.id) || '', repoDir })
```

## Judge Contract

Judging is implemented in `src/judge.ts` as a dedicated module.

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
- On validation failure: `salvagePartialResult()` recovers best-effort results when `overallScore` is present
- On complete failure: returns fallback all-zero `JudgingResult`
- The reviewer runs in the repo checkout containing the agent's code changes — launching it in an empty directory is invalid for E2E testing
- `docSuggestions` are actionable documentation edits (distinct from `weaknesses`) stored on every `TaskResult.judging` object

### Doc Suggestions Flow

`docSuggestions` flow through the pipeline as:

1. Judge writes them per-task in `JudgingResult`
2. `collectDocSuggestions()` aggregates with feature context: `### feature-id (score: 4.0/10)` + bullets
3. `runDocsRefactorAgent()` receives the aggregated text and edits docs holistically

## Init Commands

`runAgentOnCarve()` runs `execSync(initCommand, { cwd: repoDir, stdio: 'ignore', timeout: 120000 })` after cloning and checking out HEAD.

- Scripts must be committed in the repo and invokable relative to repo root
- The init command runs in the cloned checkout, not the source repo
- In worktree-based flows, `git remote get-url origin` may not be a local path; use `git worktree list | head -1 | awk '{print $1}'` for discovery
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
2. After the run, read the file: `const raw = fs.readFileSync(resultPath, 'utf-8')`
3. Parse with `JSON.parse(raw)` and validate (Zod or type assertion)
4. Cleanup (`fs.rmSync`) in a `finally` block — never let cleanup failure override a successful parse
5. If the file is missing, fall back to parsing JSON from the agent's response text
6. When parsing prose that may wrap JSON, extract the JSON object (e.g., regex for `{...}` containing expected keys), don't slice to the last `}`

## Run Report Contract

Every eval run writes `${logDir}/summary.json` and `${logDir}/report.md`.

Report sections in order:
1. `## Overview` — config table
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
    trace.txt           # Raw JSONL trace (compressed in background)
    diff.txt            # Agent's diff
    judging.json        # Full JudgingResult
    score.txt           # Numeric score
judge-suggestions-loop-<n>.txt
docs-diff-loop-<n>.txt
docs-state-loop-<n>.json
```

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
