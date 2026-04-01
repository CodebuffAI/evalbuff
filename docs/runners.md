# Runner Adapters

All runners implement the shared contract in `src/runners/runner.ts`.

```ts
export type AgentStep = PrintModeEvent  // from src/vendor/print-mode.ts

export type RunnerResult = {
  steps: AgentStep[]
  totalCostUsd: number
  diff: string
}

export interface Runner {
  run(prompt: string): Promise<RunnerResult>
}
```

## Current Runners

| Runner | File | Model | SDK |
|---|---|---|---|
| `ClaudeRunner` | `src/runners/claude.ts` | configurable (default: opus) | `@anthropic-ai/claude-agent-sdk` |
| `CodexRunner` | `src/runners/codex.ts` | `gpt-5.4` | `@openai/codex-sdk` |
| `CodebuffRunner` | `src/runners/codebuff.ts` | configurable | `@codebuff/sdk` |

## Implementing and Registering a Runner

Adding `src/runners/<name>.ts` and exporting from `src/runners/index.ts` is **not enough**. The eval entrypoint in `src/eval-runner.ts` must select the runner explicitly. Currently only `ClaudeRunner` is wired:

```ts
// src/eval-runner.ts
const runner = new ClaudeRunner(repoDir, {}, model, 'medium')
```

To add a new runner, update the selection logic there.

### Model Routing

Model routing must use precise checks. Do **not** use broad prefix matches like `model.startsWith('o')` — Claude aliases like `opus` also start with `o`. Use explicit patterns:

```ts
const isOpenAIModel = model.startsWith('gpt-') || /^o\d/.test(model)
const runner = isOpenAIModel
  ? new CodexRunner(repoDir)
  : new ClaudeRunner(repoDir, {}, model, 'medium')
```

### Optional SDK Imports

Adding a runner backed by a new provider SDK must not break importing `src/eval-runner.ts` or `src/run-evalbuff.ts` when that provider is not installed or selected. Load the runner lazily inside the model-selection branch:

```ts
const runner = model.startsWith('codebuff')
  ? new (await import('./runners/codebuff')).CodebuffRunner(repoDir, {}, model)
  : new ClaudeRunner(repoDir, {}, model, 'medium')
```

Every new dependency added to `package.json` must appear in `bun.lock`, and verification must include an import smoke test (e.g., `bun test src/__tests__/eval-runner.test.ts`) so missing SDKs are caught before merge.

### Environment Credentials

If a runner constructor accepts `env: Record<string, string>` for per-run credential overrides, it must pass credentials to the SDK as `process.env.<KEY> || env.<KEY>`:

```ts
new ProviderSDK({ apiKey: process.env.PROVIDER_API_KEY || env.PROVIDER_API_KEY })
```

Test pattern: construct the runner with only the per-run env set and assert the SDK received that key.

## Required Behavior

Every runner must:

1. Return `RunnerResult` with normalized steps, cost, and diff
2. Normalize provider events into `PrintModeEvent` format
3. Diff against the correct base commit (see Diff Capture below)
4. Avoid mutating the repo index just to capture a diff

## Diff Capture Rules

Before the agent runs, record the base SHA:

```ts
const baseSha = execSync('git rev-parse HEAD', {
  cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
}).trim()
```

After the run, capture changes using `captureGitDiff()` from `src/eval-helpers.ts`:

```ts
diff = captureGitDiff(this.cwd, { baseRef: baseSha })
```

**Do not:**
- Call `git add .` or `git add -A` inside runners — it mutates the repo index
- Diff against the final `HEAD` — agents may create commits during a run, making `git diff HEAD` empty

The diff must include:
- Tracked edits (modified files)
- Staged edits
- Committed edits since the base SHA
- Untracked files (new files created by the agent)

`captureGitDiff()` handles all of these without staging.

## Provider Normalization

Every runner must rewrite provider-native tool names into the canonical step names before pushing to `steps`. Downstream code (especially `extractDocsRead()`) only recognizes these names:

| Canonical Name | Meaning |
|---|---|
| `shell` | Shell/terminal command execution |
| `Read` or `read_file` | File read (single path in `input.path` or `input.file_path`) |
| `file_change` | File edit/write |

### Codex Normalization Example

```ts
case 'command_execution':
  steps.push({ type: 'tool_call', toolName: 'shell', input: { command: item.command } })
  break
case 'file_change':
  steps.push({ type: 'tool_call', toolName: 'file_change', input: { changes: item.changes } })
  break
```

### Codebuff Normalization

Codebuff-native tools (`run_terminal_command`, `read_files`, `read_docs`, `read_subtree`, `str_replace`, `write_file`, `apply_patch`, `propose_str_replace`, `propose_write_file`) must be mapped to the canonical names. Internal housekeeping events like `set_messages` must be filtered out.

If a new tool name is introduced by a provider, update `extractDocsRead()` in `src/eval-helpers.ts` and any trace consumers.

### Compound Events (MCP, Multi-Step Tools)

For provider events that contain both a tool invocation and its result (e.g., MCP calls), emit **both** a `tool_call` and a `tool_result` step. Preserve provenance in the tool name:

```ts
// MCP tool call
steps.push({ type: 'tool_call', toolName: `mcp:${server}:${tool}`, input: args })
steps.push({ type: 'tool_result', toolName: `mcp:${server}:${tool}`, output: item.result || item.error })
```

This ensures trace consumers can reconstruct the full interaction.

## Trace Persistence

When `saveRoundResults()` writes a trace to disk, it calls `compressAndSave()` from `src/trace-compressor.ts` in the background. The compressor:

- Supports both JSONL event streams and plain-text traces
- Extracts large tool outputs above a size threshold into numbered sidecar files (`result-000.txt`, etc.)
- Replaces inline content with stable pointers including size and content summaries
- Writes `trace.txt.compressed` alongside the raw trace, with sidecars in `trace.txt.sidecars/`

## Cost Estimation

| Runner | Method |
|---|---|
| Claude | SDK-reported `total_cost_usd` from session result |
| Codex | Token-based: `(input_tokens * 2 + output_tokens * 8) / 1_000_000` |
| Codebuff | `creditsUsed / 100` from session state |
