# Runner Adapters

All agent runners live in `src/runners/` and implement the shared `Runner` interface from `src/runners/runner.ts`.

## Shared Contract

```typescript
// src/runners/runner.ts
import type { PrintModeEvent } from '../vendor/print-mode'

export type AgentStep = PrintModeEvent
export type RunnerResult = { steps: AgentStep[]; totalCostUsd: number; diff: string }
export interface Runner { run(prompt: string): Promise<RunnerResult> }
```

`src/runners/index.ts` is a barrel re-export:
```typescript
export { ClaudeRunner } from './claude'
export { CodebuffRunner } from './codebuff'
export { CodexRunner } from './codex'
export type { Runner, RunnerResult } from './runner'
```

**Critical rule:** Extra abstractions like `BaseRunner` should only be introduced when the task explicitly asks for behavior deduplication. The `Runner` interface is intentionally minimal.

## Adding a New Runner

A new runner must:

1. **Return `RunnerResult`** with `steps: AgentStep[]`, `totalCostUsd: number`, and `diff: string`
2. **Normalize events into `PrintModeEvent` shapes** from `src/vendor/print-mode.ts`
3. **Diff against the correct base** — use an explicit base SHA (like `CodebuffRunner` uses `this.parentSha`) rather than `HEAD` when the agent may have committed changes

### Tool Name Conventions

Downstream code depends on specific tool names in `AgentStep` events:

| Action | Expected `toolName` | `input` shape |
|---|---|---|
| Shell commands | `shell` | `{ command: string }` |
| File reads | `Read` or `read_file` | `{ file_path: string }` or `{ path: string }` |
| File changes | `file_change` | `{ changes: ... }` |

If a new tool name is introduced, update consumers — especially `extractDocsRead()` in `src/eval-helpers.ts`, which parses steps to find which docs the agent read.

### Filtering Noise

Filter provider-internal events before storing trace steps. Example: `CodebuffRunner` skips `set_messages` events:
```typescript
if (event.toolName === 'set_messages') return
```

### Failure Artifacts

On failure, include both the provider error and the captured trace so debugging is possible.

## Cost Estimation

Each runner must estimate `RunnerResult.totalCostUsd`:

| Runner | Method |
|---|---|
| **Claude** | `message.total_cost_usd` from SDK result event |
| **Codex** | `(usage.input_tokens * 2 + usage.output_tokens * 8) / 1_000_000` (GPT-5.4 pricing) |
| **Codebuff** | `creditsUsed / 100` from session state |

When adding a new runner, use model-specific token pricing. `cached_input_tokens` should be discounted if the provider reports them separately. Add a deterministic test fixture, e.g.:
```typescript
// Assert cost for known token counts
const usage = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 500 }
expect(computeCost(usage)).toBeCloseTo(0.006)
```

## Event Source Mapping

| Source | Event format | Conversion notes |
|---|---|---|
| **Claude** (`@anthropic-ai/claude-agent-sdk`) | `assistant` messages with `tool_use` content blocks | Map `block.name` → `toolName`, `block.id` → `toolCallId` |
| **Codex** (`@openai/codex-sdk`) | `ThreadItem` via streaming events | `command_execution` → `shell`, `file_change` → `file_change`, `agent_message` → `text` |
| **Codebuff** (`@codebuff/sdk`) | `PrintModeEvent` natively | Direct pass-through (filter `set_messages`) |
