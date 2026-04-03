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
3. Capture a post-run repo diff without staging or committing solely for diff collection

## Diff Capture

The current runner implementations collect the diff after the run with:

```ts
execSync('git diff --binary HEAD', { cwd, encoding: 'utf-8' })
```

This snapshots tracked working-tree and staged changes relative to the current `HEAD`. Do not mutate the repo index just to make diff collection work.

## Provider Normalization

Every runner must rewrite provider-native tool names into the canonical step names before pushing to `steps`.

| Canonical Name | Meaning |
|---|---|
| `shell` | Shell/terminal command execution |
| `Read` or `read_file` | File read (single path in `input.path` or `input.file_path`) |
| `file_change` | File edit/write |

### Codex Event → Canonical Mapping

| Codex ThreadItem type | Canonical step(s) |
|---|---|
| `agent_message` | `{ type: 'text', text }` |
| `command_execution` | `{ type: 'tool_call', toolName: 'shell' }` + optional `{ type: 'tool_result', toolName: 'shell' }` |
| `file_change` | `{ type: 'tool_call', toolName: 'file_change' }` |
| `mcp_tool_call` | `{ type: 'tool_call', toolName: 'mcp:<server>:<tool>' }` + optional `tool_result` |
| `web_search` | `{ type: 'tool_call', toolName: 'web_search', input: { query } }` |
| `reasoning` | skip (internal) |
| `todo_list` | skip (internal) |

**Note**: `web_search` must not be rewritten to `shell` — the shared trace format should preserve the provider action rather than synthesizing a fake command string.

### Codebuff Normalization

Codebuff-native tools (`run_terminal_command`, `read_files`, `read_docs`, `read_subtree`, `str_replace`, `write_file`, `apply_patch`, `propose_str_replace`, `propose_write_file`) must be mapped to the canonical names. Internal housekeeping events like `set_messages` must be filtered out.

**Input shape normalization**: For providers whose read tools emit arrays or provider-specific fields, normalization must rewrite both the tool name and the input shape into the shared format consumed by downstream trace readers. A tool-name rename alone is incomplete.

### Compound Events (MCP, Multi-Step Tools)

For provider events that contain both a tool invocation and its result (e.g., MCP calls), emit **both** a `tool_call` and a `tool_result` step. Preserve provenance in the tool name:

```ts
// MCP tool call
steps.push({ type: 'tool_call', toolName: `mcp:${server}:${tool}`, input: args })
steps.push({ type: 'tool_result', toolName: `mcp:${server}:${tool}`, output: item.result || item.error })
```

This ensures trace consumers can reconstruct the full interaction.

## Failure Semantics

When a provider returns a completed session whose `output.type === 'error'` or throws during `run()`:

- If the session produced steps, cost, or file edits, the runner must still capture `diff`, compute `totalCostUsd`, and persist a structured debug dump (JSON containing `prompt`, `steps`, and serialized `error` fields)
- After capturing partial work, the runner must **reject** (throw) so `runAgentOnCarve()` can convert it to a `score = -1` infrastructure failure result
- Do not silently return a partial `RunnerResult` without indicating failure — the caller must know the run did not complete normally
- In `src/eval-runner.ts`, `createInfrastructureFailureResult()` writes `score = -1`, `judging.overallScore = -1`, empty `diff`, and plain-text `trace` beginning with `Agent error:`. Tests that inspect `round-<n>/<featureId>/` must branch on score: for `score >= 0`, JSON-parse trace lines; for `score < 0`, assert non-empty plain text trace plus matching `-1` score fields

## Trace Persistence

When `saveRoundResults()` writes a trace to disk, it calls `compressAndSave()` from `src/trace-compressor.ts` in the background. The compressor:

- Supports both JSONL event streams and plain-text traces
- For JSONL traces: replaces only large event payload fields with stable sidecar pointers (includes file reference, byte count, and a short summary)
- For plain-text traces: extracts only large embedded blocks (fenced code/output blocks, XML blocks, labelled content) while leaving the surrounding narrative inline — does not replace the entire trace with one marker
- Writes `trace.txt.compressed` alongside the raw trace, with sidecars in `trace.txt.sidecars/`
- Sidecar IDs are derived from SHA-256, so identical content always produces the same pointer
- **Round-trip requirement**: compressed traces must be lossless — `restoreTrace(compressed, sidecarDir)` reproduces the original trace byte-for-byte for arbitrary text including quotes and JSON-like snippets

## Cost Estimation

| Runner | Method |
|---|---|
| Claude | SDK-reported `total_cost_usd` from session result |
| Codex | Token-based: `(input_tokens * 2 + output_tokens * 8) / 1_000_000` |
| Codebuff | `creditsUsed / 100` from session state |
