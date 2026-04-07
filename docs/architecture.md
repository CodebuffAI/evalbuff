# Architecture

## Pipeline Overview

Evalbuff follows a plan → carve → evaluate → refactor loop:

1. **Plan** — `planFeatures()` in `src/carve-features.ts` uses a Codex agent to scan the target repo and identify 15–25 discrete features that can be cleanly removed.
2. **Carve** — `carveFeature()` creates an isolated git worktree, runs a Codex agent to remove the feature, and captures the resulting diff and file operations.
3. **Evaluate** — `runAgentOnCarve()` in `src/eval-runner.ts` clones the repo, applies the carve, copies current docs, runs a coding agent to rebuild the feature, then hands the result to `judgeTaskResult()` in `src/judge.ts`.
4. **Refactor docs** — `runDocsRefactorAgent()` in `src/docs-refactor.ts` collects judge suggestions and runs a Claude agent in a temp clone to edit `docs/`, `AGENTS.md`, and `CLAUDE.md`.
5. **Repeat** — Steps 3–4 loop N times. Each loop also re-judges the baseline diffs with current docs to separate judge recalibration from real agent improvement.

## Key Modules

| Module | Responsibility |
|---|---|
| `src/run-evalbuff.ts` | Top-level orchestrator — parses CLI args, runs the full pipeline |
| `src/eval-runner.ts` | Single-feature eval cycle: clone → carve → run agent → judge |
| `src/eval-helpers.ts` | Git/docs utilities — carve ops, docs sync, diff capture, ground-truth computation |
| `src/carve-features.ts` | Feature identification and extraction via Codex agents in git worktrees |
| `src/judge.ts` | Codex-based reviewer that scores agent output with E2E testing |
| `src/docs-refactor.ts` | Holistic docs editing agent + judge suggestion collector |
| `src/perfect-feature.ts` | Single-feature iterative optimizer (rebuild → judge → diagnose → update docs) |
| `src/report.ts` | Persists round results and generates `summary.json` + `report.md` |
| `src/trace-compressor.ts` | Extracts large tool outputs from traces into content-addressed sidecar files |
| `src/test-repo-utils.ts` | Temporary git repo lifecycle helpers (`withTestRepo`, `withTestRepoAndParent`) |
| `src/runners/` | Agent runner implementations (see [Runner Contract](./runner-contract.md)) |
| `src/tui/` | Terminal dashboard — event-driven live view of runs |
| `src/vendor/` | Shared types (`print-mode.ts` event union) and error utilities |

## Data Flow

```
Target repo
  ↓ planFeatures() → CarvePlan
  ↓ carveFeature() → CarvedFeature[]
  ↓ [saved as features.json]
  ↓
  ↓ For each round:
  ↓   runAgentOnCarve() → TaskResult (per feature, in parallel)
  ↓   saveRoundResults() → round-N/ directory
  ↓
  ↓ For each improvement loop:
  ↓   collectDocSuggestions() → text
  ↓   runDocsRefactorAgent() → edits docs in target repo
  ↓   runEvalRound() → new scores
  ↓   runBaselineRejudgeRound() → re-scored baseline
  ↓
  ↓ saveSummary() → summary.json + report.md
```

## Temp Clone Pattern

Most workflows (eval, docs refactor, judging) operate in temporary clones, not the original repo. The standard sequence is:

1. `git clone --no-checkout "<repoPath>" "<tempDir>/repo"`
2. `git checkout <headSha>` (use the HEAD of the source repo)
3. `ensureGitIdentity(repoDir)` (sets git user.name/email for commits)
4. Apply carve operations or other setup
5. `copyDocsIntoRepo(sourceRepoPath, repoDir)` — syncs `docs/`, `AGENTS.md`, `CLAUDE.md` from source into the clone and commits them
6. Run the agent
7. For docs-refactor workflows: `syncDocsIntoRepo(repoDir, sourceRepoPath)` to copy results back

**Sync-back safety**: The sync-back step (step 7) must run **only after the agent completes successfully**. If the runner throws or the agent aborts, discard the temp clone and leave the source repo untouched. Never place `syncDocsIntoRepo(cloneDir, sourceRepoPath)` on a code path that also handles agent exceptions — partial edits would overwrite the working repo. Pattern: wrap the agent run in try/catch, call `syncDocsIntoRepo` only in the success path, log and skip on failure.

**Critical**: `syncDocsIntoRepo()` copies working-tree files (not just committed HEAD), so uncommitted local doc edits are visible inside clones only if the pre-run sync is performed.

### Docs Refactor Pattern

`runDocsRefactorAgent()` in `src/docs-refactor.ts` builds a holistic prompt, not a task-specific checklist. The prompt tells the agent to:
1. Read all current docs (`docs/`, `AGENTS.md`, `CLAUDE.md`).
2. Generalize judge feedback into reusable project patterns — avoid feature-specific examples.
3. Verify every referenced symbol/path with grep before documenting it.
4. Restrict `AGENTS.md` changes to doc-index maintenance or factual corrections.
5. Sync docs back only after a successful run.

When building similar doc-editing agents, follow the same holistic approach: read first, generalize, verify, then write.

## Orchestration Patterns

There are two orchestration patterns for running agents against carved features:

1. **Standard eval cycle** — `runAgentOnCarve()` in `src/eval-runner.ts` handles the full clone → carve → run agent → judge pipeline. It always judges through `judgeTaskResult()` in `src/judge.ts`. Use this for batch evaluation rounds where all features use the same runner, judge, and result format.

2. **Custom orchestration loop** — If a command needs a different reviewer contract, different result format, model-selectable judge, or an extra analysis phase (e.g., diagnose → update docs → retry), it must implement its own rebuild/judge/analyze loop instead of delegating to `runAgentOnCarve()`. Write a new orchestration function rather than patching `runAgentOnCarve()` internals.

### Adding New Pipeline Phases or Options

When modifying the orchestration (new `EvalbuffOptions` fields, new phases, new artifact outputs), update **all** consumers in the same change:

1. **Options parsing** — the `import.meta.main` block in `src/run-evalbuff.ts` must parse and validate the new flag.
2. **TUI argument forwarding** — `src/tui/main.tsx` must pass the new option through to the orchestrator when starting a live run.
3. **Phase rendering** — if adding a new `Phase` union member, every switch/map over `Phase` (in the TUI, events, and report modules) must handle it. TypeScript exhaustiveness checks will catch most, but verify visually.
4. **Event payloads** — if the new phase emits events, add corresponding members to the `EvalbuffEvent` union in `src/tui/events.ts`.
5. **Report/summary types** — if the phase produces metrics, extend `EvalSummary` in `src/report.ts` and update `report.md` generation.

## Concurrency

Eval rounds use bounded concurrency: `opts.parallelism` workers pull from a shared queue. Each worker runs a full clone → carve → agent → judge cycle independently.

## Events and TUI

The `events` singleton (`src/tui/events.ts`) is a process-wide typed event bus. Orchestration code calls `events.send()` to emit lifecycle events. Events are:
- Buffered in memory for late subscribers (`events.replay()`)
- Persisted to `<logDir>/events.jsonl` as `{ "ts": string, "event": EvalbuffEvent }` JSONL envelopes

### Shared Log Directory Rule

Any orchestration command used by a live dashboard must share **one log directory and one event stream** with the TUI. The orchestrator must either accept a caller-provided `logDir` or return the chosen directory immediately. The TUI must not invent a parallel log directory — timestamps can collide. `events.initLog(logDir)` opens `events.jsonl` in append mode, so reusing a prior `logDir` merges multiple runs into one replay stream. Always create a collision-resistant directory (e.g., `fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-run-<timestamp>-'))` or equivalent with random suffix).

### Event Types

The `EvalbuffEvent` union in `src/tui/events.ts` defines these event types: `run_start`, `phase_change`, `feature_planned`, `feature_status`, `round_complete`, `docs_refactor`, `run_complete`, and `log`.

Key types exported from `src/tui/events.ts`:
- `Phase`: `'planning' | 'carving' | 'evaluating' | 'docs_refactor' | 'complete'`
- `FeatureStatus`: `'pending' | 'carving' | 'carved' | 'carve_failed' | 'agent_running' | 'judging' | 'scored' | 'eval_failed'`

### Required Emission Points

Every round-scoped `phase_change` event must include `round` (and `loop` when applicable), including for docs-refactor phases. The TUI keeps the last round number in state, so omitting `round` causes the dashboard and `events.jsonl` logs to label the wrong loop.

Required emission points for any orchestration command:
- Immediately after log-dir creation: `run_start` (with `repoPath`, `logDir`, config fields)
- After planning: `feature_planned` (with `totalCandidates` and `selectedIds`)
- Before/after each carve, agent run, and judge step: `feature_status` with appropriate status
- On carve failures: `feature_status` with `status: 'carve_failed'`
- On evaluation failures: `feature_status` with `status: 'eval_failed'`
- After every round: `round_complete`
- At the end: `run_complete` (with `scoreProgression`, `totalCost`, `duration`)

**Terminal event guarantee**: Every exit path in an orchestration function — including early aborts from planning/carving failures — must emit `phase_change` with `phase: 'complete'` followed by `run_complete` before returning. Use a `finally` block or shared finish path to guarantee this. Replay consumers and the TUI rely on terminal events to know the run ended rather than crashed.

### TUI Design

The TUI is **event-stream-first**: live and replay modes consume `events.jsonl` to reconstruct lifecycle state. Filesystem artifacts (`summary.json`, round directories) serve as fallback augmentation. A run with only `events.jsonl` plus `features.json` should render repo path, known features, and current progress before any summary files exist.

**Stdout discipline**: When the TUI is mounted, the terminal renderer owns stdout. Orchestration code must not emit progress via `console.log()` to stdout while the TUI is active. Route progress through `events.send()` and render it inside the dashboard, or send diagnostic logs to stderr.
