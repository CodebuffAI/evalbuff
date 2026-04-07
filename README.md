# Evalbuff

**Improve your coding agent's performance through automated practice.**

Evalbuff runs your coding agent on practice tasks carved from your codebase, watches it fail, writes docs to fix the pattern, and keeps only the changes that measurably help. The result is a `docs/` directory of markdown files that encode the missing knowledge your agent needs to produce correct changes.

## Why it works

Your coding agent is missing context. It doesn't understand your product. It edits the wrong package. It doesn't know how to verify changes end-to-end.

All of this is solvable with the right context — missing domain knowledge, subtle conventions, step-by-step verification workflows. And all of that context can be recorded in plain markdown files.

### Hierarchical docs > skills

[OpenAI](https://openai.com/index/harness-engineering/) and [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) have independently converged on a pattern for increasing agent performance:

- A `docs/` directory with nested markdown files
- A table of contents in `AGENTS.md` (or `CLAUDE.md`) with descriptions so the agent reads the right docs

Evalbuff automates building and maintaining this docs directory — and validates every change against real evals.

### Not just docs, evalmaxxing docs

The goal isn't to produce docs that explain your project. The goal is to include whatever knowledge or instructions **increase the performance of your coding agent on evals** — domain knowledge missing from raw code, processes for end-to-end verification, and guardrails that prevent common mistakes.

## How it works

Evalbuff creates practice tasks by **carving** — surgically removing a feature from your codebase (deleting the relevant code while keeping everything else intact) and then challenging an agent to rebuild it from scratch. The original implementation serves as ground truth for judging the result.

```
1. Identify features in the repo that can be cleanly carved out
2. Carve a random subset of n features (delete the code, keep the rest)
3. Baseline: have agents rebuild each carved feature in parallel, judge the results
   against the original implementation, collect scores + doc suggestions
4. Loop N times:
   a. Docs refactor agent reads judge suggestions and edits docs holistically
   b. Re-eval: rebuild in parallel, judge, get new scores + doc suggestions
   c. Keep only doc changes that improve scores
```

## Usage

Try it now! Simply run the `run-evalbuff.ts` script with the path to your repo:

```bash
bun run src/run-evalbuff.ts \
  --repo /path/to/repo \
  [--n 20] \
  [--parallelism 3] \
  [--loops 3] \
  [--init-command "npm install"]
```

| Flag | Description |
|------|-------------|
| `--repo` | Path to the repo to optimize docs for |
| `--n` | Number of features to carve per eval round (default: 20) |
| `--parallelism` | How many agent runs to execute in parallel (default: 3) |
| `--loops` | Number of doc-improvement iterations (default: 3) |
| `--init-command` | Setup command to run in the repo before each agent run (e.g. `npm install`) |
| `--coding-model` | Model for the coding agent (default: sonnet) |
| `--docs-model` | Model for the docs writer agent (default: opus) |

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
