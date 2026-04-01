# Evalbuff

Evalbuff improves a coding agent's performance by running it for practice to re-implement features and iteratively optimizing what context the agent receives. It watches an agent fail, writes docs to fix the pattern, and keeps only the changes that measurably help.

## Docs

IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. Always read the relevant docs below before implementing changes.

- `docs/evaluation-workflow.md` — Full pipeline: plan → carve → eval → judge → docs refactor → repeat
- `docs/runners.md` — Runner adapter contract, registration, tool normalization, diff capture
- `docs/eval-helpers.md` — Git/docs helper functions and test-repo utilities
- `docs/testing.md` — Test framework, scripts, and patterns
- `docs/interpreting-task-prompts.md` — How to read carved feature prompts and maintain contract fidelity

## Project Structure

```
src/
├── run-evalbuff.ts        # Main CLI orchestrator
├── eval-runner.ts         # Runs one agent on one carved feature
├── carve-features.ts      # Plans and carves features using Codex
├── judge.ts               # Codex-based reviewer with Zod-validated scoring
├── docs-refactor.ts       # Holistic docs improvement via Claude
├── eval-helpers.ts        # Git, docs-sync, diff, and trace helpers
├── report.ts              # Artifact persistence and markdown report generation
├── trace-compressor.ts    # Extracts large tool outputs into sidecar files
├── test-repo-utils.ts     # Temp git repo lifecycle for testing
├── runners/
│   ├── runner.ts          # Shared Runner interface and types
│   ├── claude.ts          # Claude Code runner (primary)
│   ├── codex.ts           # Codex/GPT-5.4 runner
│   ├── codebuff.ts        # Codebuff runner
│   └── index.ts           # Re-exports
└── vendor/
    ├── print-mode.ts      # PrintModeEvent union type (shared trace format)
    └── error.ts           # Error serialization
```

## Key Conventions

- Runtime: Bun (not Node). Entry points use `import.meta.main` for CLI guards.
- This repo commits only `bun.lock` (no `package-lock.json`). Dependency changes must regenerate `bun.lock`. Verify with `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test`.
- Validation: All schema validation uses **Zod v4** imported from `zod/v4`. Never import from `zod` directly (Zod v3). This applies to all files across the project.
- Agents: Codex (GPT-5.4) for planning, carving, and judging. Claude Code for rebuilding features and refactoring docs. The docs refactor agent uses `docsModel`, not `codingModel`.

### Docs-Code Consistency

Documentation in `docs/` must describe the current codebase, not planned future behavior.

- When docs mention a helper, type, or function, the export must exist in `src/` with a matching signature (or be added in the same change).
- When docs say the pipeline calls a helper, at least one real call site must exist.
- Every script listed in docs must exist in `package.json`. Verify by running the command.
- When adding a new docs reference to a helper name (e.g., `captureGitDiff`, `getGroundTruthDiff`), grep for it in `src/` first to confirm it exists.

### Implementation Scope

- Keep changes narrowly scoped to the task. Do not add unrelated docs, refactors, or dependency changes.
- When rebuilding a carved feature, match the exact file path, export names, function signatures, and field names from the ground truth diff. Do not rename contracts or "improve" the API.
- **Lockfile rule**: Do not modify `bun.lock` unless `package.json` changed in the same diff. Use `bun install --frozen-lockfile` to verify consistency. If it reveals pre-existing drift unrelated to the task, report it separately instead of silently fixing it.

### Cross-File Wiring

When a change touches multiple files (new helper, new interface field, new pipeline stage), all consumers must be updated together:

- Grep `src/` for every importer of a changed module before finishing
- Every public function signature must match at all call sites
- New fields on shared interfaces (e.g., `TaskResult`, `CarvedFeature`) must be threaded through all constructors, fallback paths (including `score = -1` infra-failure paths), and persistence/rendering code
- A change that adds an export without wiring it to at least one real call site is incomplete

### Pre-Submit Verification

Before finishing any task, run this checklist:

1. `bun install --frozen-lockfile` — catches dependency drift
2. `bun run typecheck` — catches cross-file wiring errors
3. `bun test src/__tests__/<focused-file>` — the test most relevant to the change
4. `git diff --stat` — every file touched must be justified by the task scope
5. For new/modified exports: verify the import works (`bun --eval "await import('./src/<module>.ts')"` or grep for importers)

### CLI Contracts

User-facing CLI entrypoints (`src/run-evalbuff.ts`, `src/carve-features.ts`) follow these rules:

- Implement the exact flag spellings specified in the task or README. The stable flags for the main CLI are `--repo`, `--n`, `--parallelism`, `--loops`, `--init-command`, `--coding-model`, `--docs-model`.
- Validate arguments before any orchestration side effects, in this order: (1) `--repo` path exists, (2) `git rev-parse --show-toplevel` succeeds in that path, (3) numeric flags parse as valid integers. A bad repo must fail with a local validation error — it must not start Codex/Claude, create `evalbuff-run-*` directories, or write repo artifacts.
- A CLI change is incomplete without: the runnable file in `src/`, the `package.json` script (if applicable), and matching README usage with exact flag spellings and defaults.
- Expose a reusable library function plus a thin CLI wrapper. The CLI parses argv, calls the function, prints progress, and sets exit codes. This keeps orchestration importable by tests and other modules.

### Two Distinct Orchestration Paths

`runEvalbuff()` in `src/run-evalbuff.ts` and `carveFeatures()` in `src/carve-features.ts` are separate orchestration paths — do not mix them:

- **`runEvalbuff()`** — the eval pipeline. Calls `planFeatures()` directly, selects candidates with `selectRandom()`, carves with `carveFeature()`, and keeps all run artifacts in `os.tmpdir()`.
- **`carveFeatures()`** — the standalone carve CLI. Ranks candidates by complexity instead of random selection and writes `carve-<date>.json` into the target repo by default.

The eval orchestrator should never call `carveFeatures()` from `src/carve-features.ts`.
