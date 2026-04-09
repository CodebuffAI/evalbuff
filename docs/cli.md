# CLI Commands

## Main Pipeline

```bash
  bun run src/run-evalbuff.ts \
  --repo /path/to/repo \
  [--n 20] \
  [--parallelism 1] \
  [--loops 1] \
  [--init-command "npm install"] \
  [--coding-model sonnet] \
  [--docs-model opus] \
  [--cached-features /path/to/features.json]
```

All flags are parsed explicitly in the `import.meta.main` block. Required flags must be validated with helpful errors. The `--cached-features` flag skips planning/carving and loads pre-carved features directly. Improvement loops now run features sequentially and gate docs changes one candidate at a time; `--parallelism` still applies to carving/setup concurrency, not the per-loop feature order.

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
  [--init-command "npm install"]
```

Iteratively rebuilds a single feature: rebuild → judge → diagnose → update docs → repeat until 10/10 or max rounds.

## Trace Compressor

```bash
bun run src/trace-compressor.ts <input> [options]       # Compress
bun run src/trace-compressor.ts --restore <compressed>   # Restore
```

Options: `--output`, `--sidecar-dir`, `--threshold <bytes>`, `--format auto|jsonl|text`, `--summarize heuristic|claude|none`. Supports stdin/stdout with `-`.

## TUI Dashboard

```bash
bun run tui                                    # Run picker (scan recent dirs)
bun run tui -- --demo                          # Demo mode with simulated data
bun run tui -- --log-dir /path/to/run-dir      # Replay/watch a specific run
bun run tui -- --repo /path/to/repo            # Start a live run with TUI attached
```

`--demo`, `--log-dir`, and `--repo` are mutually exclusive top-level mode selectors parsed inline in `main()` within `src/tui/main.tsx`. `--repo` starts a live evalbuff run with the dashboard attached (not the run picker). When no mode is specified, the TUI shows a run picker scanning for recent run directories.

**Navigation**: `Enter` drills into detail screens, `Esc` goes back, `q` quits. Arrow keys and `j`/`k` navigate lists.

**Run discovery**: On macOS, run directories may appear under both `os.tmpdir()` (which resolves through `/private/var/...`) and `/tmp`. Discovery logic must scan both locations to find all runs.

## CLI Conventions

For any new CLI command:

1. **Define a typed options object** whose fields exactly match the public contract. Every advertised flag in the file header, docs example, and `package.json` script must be parsed explicitly in the `import.meta.main` block. Unknown or future flags must not be silently accepted.
2. **Validate required flags** and print helpful error messages for missing ones. Exit early with usage text rather than failing deep in the pipeline.
3. **Add a `scripts` entry** in `package.json`.
4. **Keep the CLI contract consistent** between the file header usage comment, the flag parser, the options type, and the `package.json` script entry.
5. **Log non-default options** in startup output when they affect behavior (e.g., model overrides, parallelism).
6. **Thread every flag** through the options type into the runtime path — never parse a flag and ignore it.

### New Command Checklist

- [ ] Typed options interface with one field per flag
- [ ] Every flag parsed in `import.meta.main`
- [ ] Required flags validated with helpful errors
- [ ] `package.json` script entry added
- [ ] File header usage comment matches actual flags
- [ ] Non-default values logged at startup
- [ ] At least one black-box CLI test that passes a non-default value and verifies behavior changes
