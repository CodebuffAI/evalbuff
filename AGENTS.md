# Evalbuff

Evalbuff improves a coding agent's performance by running it for practice to re-implement features and iteratively optimizing what context the agent receives. It watches an agent fail, writes docs to fix the pattern, and keeps only the changes that measurably help.

## Docs

IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. Always read the relevant docs below before implementing changes.

- `docs/interpreting-task-prompts.md` — How to interpret auto-generated task prompts from commit history, and when to trust ground truth diffs over prompt text.
