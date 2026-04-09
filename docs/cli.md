# CLI Commands

## Main Pipeline

```bash
  bun run src/run-evalbuff.ts \
  --repo /path/to/repo \
  [--n 20] \
  [--init-command "npm install"] \
  [--coding-model sonnet] \
  [--docs-model opus] \
  [--cached-features /path/to/features.json] \
  [--output-dir /path/to/output]
```

All flags are parsed explicitly in the `import.meta.main` block. Required flags must be validated with helpful errors. The `--cached-features` flag skips planning/carving and loads pre-carved features directly. The `--output-dir` flag overrides the default artifact location (`<repo>/.evalbuff`). Evalbuff now always runs a single sequential improvement round after baseline, and carve concurrency is an internal fixed constant rather than a public flag.

## Perfect Feature (Single-Feature Optimizer)

```bash
bun run src/perfect-feature.ts \
  --repo /path/to/repo \
  --features features.json \
  --feature-id <id> \
  [--max-rounds 10] \
  [--coding-model sonnet] \
  [--judge-model opus] \
  [--analyzer-model opus] \
  [--docs-model opus] \
  [--init-command "npm install"] \
  [--output-dir /path/to/output]
```

Iteratively rebuilds a single feature: rebuild → judge → diagnose → update docs → repeat until 10/10 or max rounds.

## Trace Compressor

```bash
bun run src/trace-compressor.ts <input> [options]       # Compress
bun run src/trace-compressor.ts --restore <compressed>   # Restore
```

Options: `--output`, `--sidecar-dir`, `--threshold <bytes>`, `--format auto|jsonl|text`, `--summarize heuristic|claude|none`. Supports stdin/stdout with `-`.

## E2E Benchmark Repo Setup

```bash
bun run setup:e2e-repos
bun run setup:e2e-repos -- --repo mock-simple
bun run setup:e2e-repos -- --root /tmp/evalbuff-test-repos --force
```

Creates deterministic local benchmark repos under `test-repos/` by default:
- `mock-simple` — generated locally for fast/mock E2E coverage
- `codebuff` — pinned checkout of `CodebuffAI/codebuff`
- `manifold` — pinned checkout of `manifoldmarkets/manifold`, plus a local fixture commit that renames `docs/` to `external-docs/`

Flags:
- `--root <path>` chooses the target directory
- `--repo <id>` limits setup to specific repo ids and may be repeated
- `--force` rebuilds fixture directories that already exist

## TUI Dashboard

```bash
bun run tui                                    # Run picker (scan recent dirs)
bun run tui -- --demo                          # Demo mode with simulated data
bun run tui -- --log-dir /path/to/run-dir      # Replay/watch a specific run
bun run tui -- --repo /path/to/repo            # Start a live run with TUI attached
```

`--demo`, `--log-dir`, and `--repo` are mutually exclusive top-level mode selectors parsed inline in `main()` within `src/tui/main.tsx`. `--repo` starts a live evalbuff run with the dashboard attached (not the run picker). When no mode is specified, the TUI shows a run picker scanning for recent run directories.

**Navigation**: `Enter` drills into detail screens, `Esc` goes back, `q` quits. Arrow keys and `j`/`k` navigate lists.

**Run discovery**: The TUI scans `.evalbuff/` in the current working directory (the default output location) as well as legacy temp locations (`os.tmpdir()` and `/tmp` on macOS) to find all runs.

## CLI Conventions

For any new CLI command:

1. **Define a typed options object** whose fields exactly match the public contract. Every advertised flag in the file header, docs example, and `package.json` script must be parsed explicitly in the `import.meta.main` block. Unknown or future flags must not be silently accepted.
2. **Validate required flags** and print helpful error messages for missing ones. Exit early with usage text rather than failing deep in the pipeline.
3. **Add a `scripts` entry** in `package.json`.
4. **Keep the CLI contract consistent** between the file header usage comment, the flag parser, the options type, and the `package.json` script entry.
5. **Log non-default options** in startup output when they affect behavior (e.g., model overrides).
6. **Thread every flag** through the options type into the runtime path — never parse a flag and ignore it.

### New Command Checklist

- [ ] Typed options interface with one field per flag
- [ ] Every flag parsed in `import.meta.main`
- [ ] Required flags validated with helpful errors
- [ ] `package.json` script entry added
- [ ] File header usage comment matches actual flags
- [ ] Non-default values logged at startup
- [ ] At least one black-box CLI test that passes a non-default value and verifies behavior changes
