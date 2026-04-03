# Evalbuff

Evalbuff improves a coding agent's performance by running it for practice to re-implement features and iteratively optimizing what context the agent receives. It watches an agent fail, writes docs to fix the pattern, and keeps only the changes that measurably help.

## Docs

**MANDATORY**: You MUST read the relevant docs below before implementing ANY changes. Do not rely on pre-training knowledge about this codebase — always retrieve and read the actual docs first. Skipping docs is the #1 cause of failed implementations.

Start your response by reading whichever `docs/` files are relevant to your task based on the descriptions below:

- `docs/evaluation-workflow.md` — **Read when**: working on the eval pipeline, carving, judging, docs refactor, or the run-evalbuff orchestrator. Covers the full pipeline: plan → carve → eval → judge → docs refactor → repeat.
- `docs/runners.md` — **Read when**: adding/modifying a runner, changing how agents are invoked, or working on diff capture. Covers the runner adapter contract, registration, tool normalization, and diff capture.
- `docs/eval-helpers.md` — **Read when**: working on git operations, docs syncing, carve application, or test-repo utilities. Covers helper functions used by eval-runner and test infrastructure.
- `docs/testing.md` — **Read when**: writing or modifying tests, adding test scripts, or verifying test conventions. Covers the test framework, scripts, patterns, and pre-submit verification.

When in doubt about whether a doc is relevant, **read it anyway** — it takes seconds and prevents hours of rework.

## Verification

Verify changes with at least `bun run typecheck` and `bun test`.
