# Evalbuff

**Automate coding via offline practice.**

Evalbuff improves your coding agent overnight:

- A background agent practices making changes in your codebase
- Learnings are documented in markdown files
- Only learnings that increase eval performance are kept

## Why

Your coding agent needs more knowledge to do the best work in your codebase.

We can discover what produces optimal performance through practice reconstructing your codebase.

Markdown docs in a nested directory are all that's necessary to give the agent proper context on your project and how to end-to-end verify new changes.

### Hierarchical docs > skills

[OpenAI](https://openai.com/index/harness-engineering/) and [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) have independently converged on a pattern for increasing agent performance:

- A `docs/` directory with nested markdown files
- A table of contents in `AGENTS.md` (or `CLAUDE.md`) with descriptions so the agent reads the right docs

Evalbuff automates building and maintaining this docs directory — and validates every change against real evals.

### Not just docs, evalmaxxing docs

The goal isn't to produce docs that explain your project. The goal is to include whatever knowledge or instructions **increase the performance of your coding agent on evals** — domain knowledge missing from raw code, processes for end-to-end verification, and guardrails that prevent common mistakes.

## How it works

Evalbuff creates practice tasks by **carving** your codebase — surgically removing a feature from (deleting the relevant code while keeping everything else intact) and then challenging an agent to rebuild it from scratch. The original implementation serves as ground truth for judging the result.

```
1. Identify features in the repo that can be cleanly carved out
2. Carve a random subset of n features (delete the code, keep the rest)
   against the original implementation, collect scores + doc suggestions
3. Loop through each feature:
   b. Rebuild the feature
   c. Judge the result, including looking at the agent trace
   a. A docs refactor agent reads the judge suggestions and makes indpendent docs changes
   c. Keep only doc changes that improve scores (rerun agent + judge for each)
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
