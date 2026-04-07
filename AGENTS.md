# Evalbuff

Evalbuff improves a coding agent's performance by running it for practice to re-implement features and iteratively optimizing what context the agent receives. It watches an agent fail, writes docs to fix the pattern, and keeps only the changes that measurably help.

## Docs

**MANDATORY**: You MUST read the relevant docs below before implementing ANY changes or answering ANY question.

Start your response by reading whichever `docs/` files are relevant to your task based on the descriptions below:

- `docs/architecture.md` — **Read when**: You need to understand the pipeline, module responsibilities, data flow, or the temp-clone pattern.
- `docs/run-artifacts.md` — **Read when**: You're working with run log directories, loading/writing artifacts, or building dashboard/reporting features.
- `docs/runner-contract.md` — **Read when**: You're adding or modifying an agent runner in `src/runners/`.
- `docs/eval-helpers.md` — **Read when**: You need to use docs sync, diff capture, carve operations, or ground-truth helpers.
- `docs/cli.md` — **Read when**: You're adding or modifying CLI commands or `package.json` scripts.
- `docs/testing.md` — **Read when**: You're writing or modifying tests, especially E2E tests or tests involving git repos.

When in doubt about whether a doc is relevant, **read it anyway** — it takes seconds and prevents hours of rework.

## Verification

Verify changes in this order:
1. `bun test src/__tests__/<module>.test.ts` — for the changed area
2. `bun run typecheck` — TypeScript strict check
3. `bun run test` — all unit tests (excludes `*.e2e.test.ts`)

Reserve bare `bun test` or `bun run test:all` for environments where live-model E2E runs are intentionally enabled and network plus provider credentials are available.
