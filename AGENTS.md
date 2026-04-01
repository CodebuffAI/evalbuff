# Evalbuff

Evalbuff improves a coding agent's performance by running it for practice to re-implement features and iteratively optimizing what context the agent receives. It watches an agent fail, writes docs to fix the pattern, and keeps only the changes that measurably help.

## Docs

IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. Always read the relevant docs below before implementing changes.

- `docs/example.md` — Example doc. Feel free to delete.

## Key Conventions

- This repo commits only `bun.lock` (no `package-lock.json`). Dependency changes must regenerate `bun.lock`. Verify with `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test`.
