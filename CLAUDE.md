# Claude Code Context

See `AGENTS.md` for full project overview, structure, and conventions.

## Quick Reference

```bash
bun run typecheck          # Type checking
bun run test               # Fast regression (trace-compressor)
bun run test:all           # All tests
bun run test:e2e           # E2E tests only
bun run run                # Run evalbuff pipeline (alias for src/run-evalbuff.ts)
```

## Key Types

- `TaskResult` — `src/eval-runner.ts` — Score, diff, trace, judging, docsRead for one feature
- `CarvedFeature` — `src/carve-features.ts` — Feature with originalFiles, operations, diff
- `JudgingResult` — `src/judge.ts` — Zod-validated scores (0-10) plus docSuggestions
- `RunnerResult` — `src/runners/runner.ts` — Steps, cost, diff from any runner
- `RoundResult` — `src/report.ts` — Aggregated tasks for one eval round

## Score Semantics

- `0-10`: Agent ran and judge produced a score
- `-1`: Infrastructure failure (agent crash, repo setup failure)
- Filter on `score >= 0` when computing averages
