# Evalbuff

Evalbuff improves a coding agent's performance by running it for practice to re-implement features and iteratively optimizing what context the agent receives. It watches an agent fail, writes docs to fix the pattern, and keeps only the changes that measurably help.

## Docs

IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. Always read the relevant docs below before implementing changes.

- `docs/interpreting-task-prompts.md` — How to interpret auto-generated task prompts; when to trust ground truth over prompt text; preserving exact public APIs and contracts.
- `docs/runners.md` — Runner adapter contract (`src/runners/`), shared types, tool name conventions, cost estimation, adding new runners.
- `docs/eval-helpers.md` — `withTestRepo`, `copyDocsIntoRepo`, `extractDocsRead`, `computeGroundTruthDiff`, git diff capture patterns.
- `docs/evaluation-workflow.md` — Full pipeline contract, `TaskResult` failure semantics (score -1 vs 0), inter-round docs refactor, artifact layout.
- `docs/testing.md` — Test tiers (unit/integration/E2E), Bun gotchas, carve fixture conventions, dependency management.

## Key Conventions

- Both `package-lock.json` and `bun.lock` must be updated together when editing `package.json`.
- Runners must return `RunnerResult` and normalize events into `PrintModeEvent` shapes from `src/vendor/print-mode.ts`.
- `TaskResult.score = -1` means infrastructure failure (agent/judge crashed), not a bad implementation. Filter on `score >= 0` for averages.
