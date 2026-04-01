# Evaluation Workflow

The full evalbuff pipeline: plan → carve → eval → judge → refactor docs → repeat.

## Entry Point

`runEvalbuff(opts)` in `src/run-evalbuff.ts` orchestrates everything. The single-feature evaluator is `runAgentOnCarve(opts)` in `src/eval-runner.ts`.

```typescript
// src/eval-runner.ts
runAgentOnCarve({
  idx, total,
  repoPath: string,
  feature: CarvedFeature,
  initCommand?: string,
  model: string,
  groundTruthDiff: string,   // Pass the actual reference diff explicitly
  docsSourcePath: string,
}): Promise<TaskResult>
```

**Important:** Pass the actual reference diff as `groundTruthDiff` directly into judging. Do not reconstruct it from `CarvedFeature.operations` unless you also captured pre-carve contents for every changed path (see gotcha in `docs/eval-helpers.md`).

## TaskResult & Failure Semantics

```typescript
interface TaskResult {
  featureId: string
  prompt: string
  score: number       // 0-10 for judged results, -1 for infrastructure failures
  diff: string
  trace: string
  judging: JudgingResult
  costEstimate: number
  docsRead: string[]
}
```

**Score = -1 means infrastructure failure**, not a bad implementation:

| Scenario | `score` | `diff` | `trace` | `costEstimate` | `docsRead` |
|---|---|---|---|---|---|
| Agent ran, judge scored it | 0–10 | agent's diff | compressed trace | actual cost | parsed from steps |
| Agent crashed / couldn't run | -1 | `''` | `'Agent error: <message>'` | 0 | `[]` |
| Agent ran, judge crashed | 0 (fallback) | agent's diff | compressed trace | actual cost | parsed from steps |

This distinction matters: `0` means the agent produced work that was judged as failing badly. `-1` means the task never produced a valid submission. Pipeline code filters on `score >= 0` for averages.

## Inter-Round Docs Refactor

`collectDocSuggestions()` in `src/docs-refactor.ts` formats judge feedback for the refactor agent. It preserves task context:

```
### <featureId> (score: <score>/10)
- <docSuggestion bullet>
- <docSuggestion bullet>

### <featureId2> (score: <score>/10)
- ...
```

Do not flatten suggestions into a bare deduplicated list — the feature context helps the refactor agent understand which task exposed each gap.

The docs refactor agent runs even when there are zero suggestions — `collectDocSuggestions()` returns empty string, and the prompt includes `(No suggestions were made)` so the agent can still do a holistic pass.

## Artifacts

Each run produces a timestamped log directory under `$TMPDIR/evalbuff-run-<timestamp>/`:

```
plan.json              # Feature candidates from planner
features.json          # Carved features with operations + originalFiles
round-0/               # Baseline
  summary.json
  <featureId>/
    trace.txt
    diff.txt
    judging.json
    score.txt
round-1/               # After first docs refactor
  ...
judge-suggestions-loop-1.txt
docs-diff-loop-1.txt
docs-state-loop-1.json
summary.json           # Final summary with score progression
report.md              # Human-readable markdown report
```

## Carve Features Contract

`planFeatures()` returns structured candidates with: `id`, `name`, `prompt`, `description`, `files`, `relevantFiles`, `complexity`.

`carveFeature()` produces a `CarvedFeature`:
```typescript
interface CarvedFeature {
  id: string
  prompt: string
  description: string
  complexity: 'small' | 'medium' | 'large'
  originalFiles: Record<string, string>  // Pre-carve file contents
  operations: FileOperation[]            // delete/modify operations applied
  diff: string                           // Git diff of the carve
}
```

After carving, the main repo must be clean: `git status --porcelain` should be empty and `git worktree list` should show only the primary worktree.
