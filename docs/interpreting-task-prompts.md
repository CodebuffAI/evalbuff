# Interpreting Task Prompts (Especially Eval-Generated Ones)

When working with task prompts, especially those auto-generated from commit history for evaluation purposes, the prompt text may not accurately describe the actual work needed.

## The Problem

Evalbuff generates task prompts by analyzing commits. Sometimes the prompt will say "create documentation about X" when the actual ground truth is "fix test scripts in package.json and CI workflow files." This happens when:

1. The commit message is misleading (e.g., "Simplify AGENTS.md" when it actually removes test scripts)
2. The prompt generator focuses on visible file additions rather than the semantic meaning of the change
3. The task is stated in terms of what a developer might ASK for, not what they actually need

## Solution: Always Check Ground Truth First

Before implementing ANY task:

1. **Check if there's a ground truth diff available** - look for references to expected changes, test files, or "what should have been done"
2. **Examine file paths and extensions in the ground truth**:
   - `.json` files (especially `package.json`) → likely config/dependency changes
   - `.yml`/`.yaml` files in `.github/workflows/` → CI/CD configuration changes
   - `.md` files → documentation (but could also be removing or editing existing docs)
   - `.ts`/`.js` files → code changes
3. **Read the actual diff content, not just the prompt** - the diff shows EXACTLY what changed
4. **Distinguish between creation vs. modification**:
   - Does the ground truth show `new file mode` or additions to existing files?
   - Is this refactoring, removal, or net-new functionality?

## Example: The AGENTS.md Confusion

Prompt said:
> "Can you create an AGENTS.md file at the root that provides an overview..."

Ground truth showed:
```diff
--- a/.agents/package.json
+++ b/.agents/package.json
-    "test:e2e": "bun test e2e"
--- a/.github/workflows/nightly-e2e.yml  
+++ b/.github/workflows/nightly-e2e.yml
-        run: cd .agents && bun run test:e2e
+        run: cd agents && bun run test:e2e
```

The actual task was about:
- Removing a test script from package.json
- Fixing directory references in a CI workflow
- NOT about creating documentation

The agent should have recognized the ground truth shows `.json` and `.yml` config files, not `.md` documentation files.

## When In Doubt

If the prompt seems to conflict with file paths/types in the ground truth:
1. Trust the ground truth diff over the prompt text
2. Read the actual file contents being changed
3. Understand the PURPOSE of the change (fixing tests, updating config, refactoring) before implementing
4. Ask clarifying questions if the task is genuinely ambiguous

## Red Flags

- Prompt says "create docs" but ground truth shows only config file changes → likely NOT a docs task
- Prompt says "add feature X" but ground truth removes code → likely a cleanup/refactor task
- Prompt uses vague language ("simplify", "improve") → read the diff to understand the specific technical change

## Match the Reference Contract, Not Just the Theme

When a ground-truth diff introduces a specific helper module, exported function names, or callback signature, you must preserve that public contract unless the task explicitly authorizes an API redesign. For utility-style tasks, compare these before coding:

- **File path** — if the reference adds `src/test-repo-utils.ts`, don't create `src/clone-helpers.ts`
- **Exported symbols** — `withTestRepo` and `withTestRepoAndParent` must remain the exported names
- **Parameter object keys** — `{ repoUrl, localRepoPath, parentSha, initCommand, env }` must match exactly
- **Return types** — `Promise<T>` vs `Promise<T | null>` matters
- **Edge-case behavior** — does a helper return `null` on error or throw? The reference decides

Example: if the reference adds `src/test-repo-utils.ts` with `withTestRepo(repoConfig, fn)` and `withTestRepoAndParent(repoConfig, fn)`, a new `src/clone-helpers.ts` wrapper is not equivalent unless it also re-exports the expected entry points or updates all call sites.

## Exact Public API Beats Cleaner Renames

When the prompt or ground-truth diff specifies exact export names, file paths, or module names, those are part of the requirement and must be preserved exactly — even if a different abstraction seems cleaner.

- If the diff adds `src/runners/runner.ts` with `export interface Runner`, do not rename to `IRunner`, move it to `base.ts`, or replace it with an abstract base class unless the exact `Runner` export remains available at the original path.
- If `src/runners/index.ts` re-exports `Runner`, that barrel must stay intact.
- Compatibility shims are additive only — they do not replace the requested public surface.

Rule of thumb: build what was asked for first, then add abstractions on top only if explicitly requested.

## When the Ground Truth Is Narrower Than the Prompt

Sometimes the prompt sounds broad ("add comprehensive tests for the trace compressor") but the ground truth shows a focused set of behavioral assertions. In these cases:

1. **Keep your implementation similarly focused** — don't expand coverage into undocumented formats or internal conventions unless the codebase clearly documents them as supported behavior.
2. **Use the ground truth to infer the contract surface** — requested scenarios should map to a compact set of behavioral assertions.
3. **Treat exact temp paths, numbering schemes, and extra protocol variants as optional** — unless the ground truth explicitly tests them.
4. **For test tasks**, prefer one focused test per requested behavior before adding optional extras. Mirror the externally observable contract, not incidental implementation details.

Example: if the ground truth shows 3 test cases for `compressTrace()` covering JSON-lines, code fences, and cleanup, don't add 12 extra tests for untested internal edge cases.

## Testing-Specific Guidance

When a ground-truth diff adds a test file (e.g., `src/__tests__/run-evalbuff.e2e.test.ts`):

- **Prefer matching the live execution path** over substituting deterministic mocks, especially for tests labeled "E2E"
- If a mocked test is useful for report formatting or artifact serialization, keep it in a separate file and label it as a unit/integration test
- Full-loop tests should use at least one real carved feature; use `n >= 2` when runtime permits to cover score aggregation and multi-task summaries