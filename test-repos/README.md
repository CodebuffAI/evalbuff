# E2E Test Repos

Generated benchmark repos live here and stay untracked.

Set them up with:

```bash
bun run setup:e2e-repos
```

Pinned upstream sources:

- `codebuff`: `CodebuffAI/codebuff` at `f95f9a58ebcfcfecc8c6ffcfbe6d606ec1278e54`, plus a local commit that removes `docs/` and rewrites `AGENTS.md`
- `manifold`: `manifoldmarkets/manifold` at `89c1b733190ff717ff7f7d7fb6206b09c61aebd1`, plus a local commit that renames `docs/` to `external-docs/`

The generated mock repo is created locally and committed deterministically.
