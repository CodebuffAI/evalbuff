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
- Validation: Zod v4 (import from `zod/v4`).
- Agents: Codex (GPT-5.4) for planning, carving, and judging. Claude Code for rebuilding features and refactoring docs.

### Docs-Code Consistency

Documentation in `docs/` must describe the current codebase, not planned future behavior.

- When docs mention a helper, type, or function, the export must exist in `src/` with a matching signature (or be added in the same change).
- When docs say the pipeline calls a helper, at least one real call site must exist.
- Every script listed in docs must exist in `package.json`. Verify by running the command.
- When adding a new docs reference to a helper name (e.g., `captureGitDiff`, `getGroundTruthDiff`), grep for it in `src/` first to confirm it exists.

### Implementation Scope

- Keep changes narrowly scoped to the task. Do not add unrelated docs, refactors, or dependency changes.
- When rebuilding a carved feature, match the exact file path, export names, function signatures, and field names from the ground truth diff. Do not rename contracts or "improve" the API.
- When writing tests, limit the diff to the test file and truly required support changes. Do not regenerate `bun.lock` unless `package.json` changed.
- Pre-submit check: compare `git diff --stat` to the task scope. Every extra file touched must be directly required.

### CLI Contracts

User-facing CLI entrypoints (`src/run-evalbuff.ts`, `src/carve-features.ts`) follow these rules:

- Implement the exact flag spellings specified in the task or README. The stable flags for the main CLI are `--repo`, `--n`, `--parallelism`, `--loops`, `--init-command`, `--coding-model`, `--docs-model`.
- Validate required and numeric arguments. Smoke-test with at least one invocation.
- A CLI change is incomplete without: the runnable file in `src/`, the `package.json` script (if applicable), and matching README usage.
- Expose a reusable library function plus a thin CLI wrapper. The CLI parses argv, calls the function, prints progress, and sets exit codes. This keeps orchestration importable by tests and other modules.
