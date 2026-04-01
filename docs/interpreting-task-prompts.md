# Interpreting Task Prompts

Evalbuff task prompts are derived artifacts, not perfect specifications.

## Core Rule

When prompt text and repo ground truth disagree, prefer the ground truth.

In practice, that means:

- Preserve the public API implied by the carved diff
- Restore the exact wiring the repo used before the carve
- Treat tests, file structure, and existing conventions as stronger evidence than loose prompt wording

## When Rebuilding a Carved Feature

Use the prompt to understand intent, then verify against:

1. Project docs (`docs/`, `AGENTS.md`, `CLAUDE.md`)
2. Surrounding code and import patterns
3. The judge feedback
4. The actual carve diff when available

## Contract Fidelity Checklist

When a carve adds or restores a helper module, the file path, export names, function signature, and returned object field names are part of the public contract. Match them exactly.

1. **Create the exact file path** from the diff — do not move files to different locations
2. **Export the exact symbol names** — do not rename `getErrorObject` to `toSerializableError`
3. **Preserve required top-level fields** on returned objects — do not restructure the shape
4. **Add only the minimal supporting code** needed to satisfy the carve
5. **Verify imports** — if the carve shows other files importing from the restored module, those imports must work with your implementation

Example: if the carve shows `src/vendor/error.ts` exporting `getErrorObject(error: unknown, options?: { includeRawError?: boolean }): ErrorObject`, implement that exact signature with those exact fields.

## What Not To Do

- Do not "improve" the feature into a different API shape
- Do not rename contracts just because the prompt was vague
- Do not ignore shared-file cleanup that the carve diff shows
- Do not add unrelated documentation, refactors, or dependency changes beyond what the carve requires
- Do not replace returned fields with a richer but different shape (e.g., adding `originalType` or `extra` when the diff shows `statusCode`, `code`, `cause`)

## Scope Control

For single-helper or single-file carves, limit edits to:

- The target source file(s)
- The smallest necessary tests
- Lockfile changes only when `package.json` actually changed

Pre-submit check: compare `git diff --stat` to the carve. If an extra file is not directly required by the carve, remove it.
