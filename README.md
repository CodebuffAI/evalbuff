# Evalbuff

Evalbuff improves a coding agent's performance by iteratively optimizing project documentation. It carves features out of a codebase, has agents rebuild them, judges the results, and uses the feedback to improve docs.

## How It Works

```
1. Plan features to carve from the repo (GPT-5.4 via Codex SDK)
2. Carve a random subset of n features
3. Baseline: rebuild each in parallel (Claude Code), judge (Codex), get scores + doc suggestions
4. Loop N times:
   a. Docs refactor agent reads judge suggestions and edits all docs holistically
   b. Re-eval: rebuild in parallel, judge, get new scores + doc suggestions
```

## Usage

```bash
bun run src/run-evalbuff.ts \
  --repo /path/to/repo \
  [--n 5] \
  [--parallelism 3] \
  [--loops 3] \
  [--init-command "npm install"] \
  [--coding-model sonnet] \
  [--docs-model opus]
```

## Architecture

| File | Role |
|------|------|
| `run-evalbuff.ts` | Main orchestrator — carve features, run agents, judge, iterate on docs |
| `eval-runner.ts` | Core agent execution — clone, carve, run agent, judge a single feature |
| `eval-helpers.ts` | Git/docs helpers — carve ops, docs sync, safe diff capture, ground truth selection |
| `docs-refactor.ts` | Docs refactor agent + judge suggestion collection in an isolated temp clone |
| `report.ts` | Logging and markdown report generation |
| `carve-features.ts` | Feature carving — identifies and removes features from a codebase |
| `judge.ts` | Codex-based reviewer agent that judges agent output with E2E testing |
| `trace-compressor.ts` | Compresses agent traces by extracting large tool results to files |
| `test-repo-utils.ts` | Isolated git repo lifecycle management |
| `runners/` | Agent runner implementations (Claude, Codex, Codebuff) |
| `vendor/` | Shared utilities (error handling, print-mode types) |

## Testing

```bash
bun run test
bun run test:all
bun run test:e2e
bun run typecheck
```

## Artifacts

Run artifacts are written under:

```bash
$TMPDIR/evalbuff-run-<timestamp>/
```
