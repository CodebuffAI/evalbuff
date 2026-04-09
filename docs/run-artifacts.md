# Run Artifacts

Every evalbuff run writes artifacts to a timestamped directory under `<repoPath>/.evalbuff/` by default (overridable with `--output-dir`):

```
<repoPath>/.evalbuff/run-YYYY-MM-DDTHH-MM-SS/
├── plan.json                          # CarvePlan (only if features were freshly planned)
├── features.json                      # CarvedFeature[] — the selected features
├── events.jsonl                       # Timestamped event stream for TUI replay
│
├── round-0/                           # Baseline round
│   ├── summary.json                   # { round, avgScore, totalCost, tasks: [{featureId, score, costEstimate}] }
│   └── <featureId>/
│       ├── trace.txt                  # Raw JSONL agent trace
│       ├── trace.txt.compressed       # Compressed trace (async, may lag)
│       ├── trace.txt.sidecars/        # Extracted large payloads + manifest.json
│       ├── diff.txt                   # Agent's unified diff
│       ├── judging.json               # Full JudgingResult from the judge agent
│       ├── agent-suggestions.json     # Coding agent doc/project suggestions
│       └── score.txt                  # Single number (overallScore)
│
├── round-1/                           # Loop 1 re-eval (same structure as round-0)
│   └── ...
│
├── baseline-rejudge-loop-1/           # Baseline diffs re-scored with loop-1 docs
│   ├── summary.json                   # { loop, avgScore, tasks: [{featureId, score}] }
│   └── <featureId>/
│       ├── judging.json               # Re-judged result (trace/diff not re-persisted)
│       └── score.txt
│
├── judge-suggestions-loop-1.txt       # Human-readable summary of accepted/rejected/overfit-skipped doc candidates
├── doc-gates-loop-1.json              # Detailed per-candidate gate results for loop 1, including overfit and low-priority rejections
├── doc-candidates-loop-1/             # Per-candidate validation artifacts for every considered docs change
│   └── <featureId>/
│       └── candidate-01/
│           ├── metadata.json          # Summary row for this candidate (status, scores, reason, docsDiff)
│           ├── suggestion.txt         # Raw suggestion text
│           ├── docs.patch             # Proposed docs patch, when available
│           ├── docs-diff.txt          # Docs diff that was tested for this candidate
│           ├── rejudge.json           # Full rejudge output for the previous trace with updated docs
│           ├── rerun-trace.txt        # Validation rerun trace when a rerun happened
│           ├── rerun-trace.txt.compressed
│           ├── rerun-trace.txt.sidecars/
│           ├── rerun-diff.txt
│           ├── rerun-judging.json
│           ├── rerun-score.txt
│           └── rerun-agent-suggestions.json
├── docs-diff-loop-1.txt               # Before/after diff of docs for loop 1
├── docs-state-loop-1.json             # Snapshot of all docs after loop 1
│
├── summary.json                       # EvalSummary — the top-level run summary
└── report.md                          # Human-readable markdown report
```

## Key Schemas

**`summary.json`** (top-level, written by `saveSummary()` in `src/report.ts`):
- `repoPath`, `startTime`, `endTime` (ISO strings)
- `featuresCarved` (number)
- `rounds[]` — `{ round, avgScore, scores: Record<featureId, number>, totalCost }`
- `totalCost`, `scoreProgression: number[]`
- `baselineRejudgeProgression?: number[]`
- `consideredDocChangesByLoop?: number[]`
- `acceptedDocChangesByLoop?: number[]`

**`round-N/summary.json`** (per-round):
- `round`, `avgScore`, `totalCost`
- `tasks[]` — `{ featureId, score, costEstimate }`

**`features.json`** (array of `CarvedFeature`):
- `id`, `prompt`, `description`, `complexity`
- `originalFiles: Record<path, content>`
- `operations[]` — `{ path, action: 'delete' | 'modify', newContent? }`
- `diff` (unified diff of the carve)

## Loop Artifact Timing

Loop artifacts (`judge-suggestions-loop-N.txt`, `doc-gates-loop-N.json`, `doc-candidates-loop-N/`, `docs-diff-loop-N.txt`, `docs-state-loop-N.json`) are written at the **log-dir root** after the sequential doc-gating pass, **before** the corresponding `round-N/` directory is created by `saveRoundResults()`. This means:

- `judge-suggestions-loop-N.txt` should exist for every completed loop, even if it is empty.
- `doc-gates-loop-N.json` contains every considered docs candidate for the loop, including accepted/rejected status, overfit/low-priority filtering, and rejudge/rerun scores when applicable.
- `doc-candidates-loop-N/` contains one directory per considered candidate with the tested docs diff, the full rejudge output when available, and the full rerun trace/diff/judging bundle when a rerun happened.
- `docs-diff-loop-N.txt` must always exist after the docs-writer step — empty string when nothing changed.
- `docs-state-loop-N.json` must always exist — contains the `getDocsSnapshot(repoPath)` result after refactoring.

Loaders and watch-mode UIs must surface loop artifacts independently of `round-N/` directory discovery, since loop files appear first.

## Loading Artifacts

The TUI data loader in `src/tui/data.ts` exports `loadLogDir(logDir)` returning a `LogDirData` object, and `reloadLogDir(existing)` which re-reads from the same `logDir`.

### LogDirData Contract

`loadLogDir()` reads these artifacts:
- `plan.json` → `CarvePlan | null` (powers feature prompts and relevant-file context in detail screens)
- `features.json` → `CarvedFeature[]` (empty array if missing); each entry's `operations[]` contains `{ path, action: 'delete' | 'modify', newContent? }`
- `summary.json` → top-level run summary or `null`
- `report.md` → `string` (empty string if missing; powers summary/report screens)
- `round-N/` directories → per-round feature data (scanned sequentially from 0, stops at first gap)
- `baseline-rejudge-loop-N/` directories → re-judged baseline data
- Root-level loop artifacts: `judge-suggestions-loop-N.txt`, `doc-gates-loop-N.json`, `docs-diff-loop-N.txt`, `docs-state-loop-N.json`

Per-feature task data comes from child directories (`round-N/<featureId>/score.txt`, `judging.json`, `diff.txt`, `trace.txt`) — not reconstructed from `summary.json`. Missing singular artifacts return `null`, missing collections return `[]`. Loaders must prefer per-feature files over round summaries so partial runs render progressively.

### Loading Precedence

For partial-run and watch-mode rendering, follow this precedence:
1. `events.jsonl` — repo metadata and live lifecycle updates
2. `features.json` — selected feature IDs/prompts (available before evaluation starts)
3. Root-level loop artifacts — available before the re-eval round starts
4. `round-N/<featureId>/` directories — per-feature task state as it lands
5. `round-N/summary.json` — round aggregates (written after all features complete)
6. Top-level `summary.json` — final completed-run snapshot only

**`summary.json` must not be treated as a prerequisite for rendering.** Feature directories are written before round summaries, and the top-level summary is written last. Watch-mode and partial-run UIs must render progressively as artifacts appear.

### Watch-Mode Refresh Triggers

Live/watch UIs must refresh on **any** progressive artifact change, not only when a new `round-N/` directory appears. Required refresh triggers:
- `features.json` first appears
- A new `round-N/<featureId>/` task directory appears
- `score.txt` or `judging.json` is written inside an existing round
- `round-N/summary.json` is written
- Top-level `summary.json` is written
- Root-level loop artifacts appear (before their corresponding round directory), including `doc-gates-loop-N.json`

Cumulative metrics like `totalCost` from `round_complete` events are **run totals**, never per-round deltas. The UI must never let displayed cumulative values decrease between rounds.

## Run Directory Naming

Valid run directories match `run-YYYY-MM-DDTHH-MM-SS` (under `.evalbuff/`) or the legacy `evalbuff-run-YYYY-MM-DDTHH-MM-SS` (under temp). Scratch directories like `evalbuff-run-review-*` or `evalbuff-run-<random>` are not real runs and must not be treated as such by discovery logic.

The `.evalbuff/` directory is automatically added to the repo's `.gitignore` on first run.

## report.md Contract

`saveSummary()` in `src/report.ts` writes **both** `summary.json` and `report.md`. Both must be generated together.

The report overview must include: repo path, start time, end time, duration, features carved, improvement round count, coding model, docs model, and total cost. The "Scores by Round" table must include one column per round plus Average and Cost rows.

When baseline rejudging is enabled, include both the baseline rejudge trajectory and explicit derived metrics:
- **Judge recalibration** = `baselineRejudgeProgression[last] - scoreProgression[0]` — measures how much the judge's scoring changed due to updated docs alone.
- **Estimated agent improvement** = `(scoreProgression[last] - scoreProgression[0]) - judgeRecalibration` — isolates real agent improvement from judge drift.

Both values must appear as visible labeled lines in the report. Per-round detail sections should render all subsections (docs-read, doc-suggestions, etc.) even when their arrays are empty, so the report shape stays predictable.

**Trace compression**: `saveRoundResults()` writes raw `trace.txt` first, then kicks off async `compressAndSave(tracePath, trace)` so `trace.txt.compressed` and `trace.txt.sidecars/manifest.json` appear later without blocking the round. Compression failures emit a warning but must not fail the round.

Always-present sections: Overview table, Score Trajectory, Scores by Round, per-round feature detail (score breakdown, analysis, strengths, weaknesses, E2E tests, docs read, doc suggestions, cost). Optional sections: Baseline Rejudge Trajectory, Baseline Scored by Each Loop's Docs, Doc Gate Summary, Per-Candidate Doc Gates, Docs Changes (per loop), and Final Documentation State.
