# Runner Contract

## Interface

All agent runners in `src/runners/` implement the `Runner` interface from `src/runners/runner.ts`:

```ts
interface Runner {
  run: (prompt: string) => Promise<RunnerResult>
}

type RunnerResult = {
  steps: AgentStep[]     // Normalized event stream
  totalCostUsd: number   // Estimated run cost
  diff: string           // Git diff of all changes
}
```

`AgentStep` is an alias for `PrintModeEvent` from `src/vendor/print-mode.ts` — a discriminated union of event types (`tool_call`, `tool_result`, `text`, `error`, etc.).

## Standard Runner Pattern

Every runner follows the same lifecycle:

1. **Record base SHA** — `const baseSha = execSync('git rev-parse HEAD', { cwd })` before the agent runs.
2. **Run the agent** — using the provider's SDK, stream events, and push each one onto `steps[]`.
3. **Capture diff** — `captureGitDiff(cwd, { baseRef: baseSha })` from `src/eval-helpers.ts` after the run. This captures both tracked changes and untracked files.
4. **Return** `{ steps, totalCostUsd, diff }`.

## Error Propagation

`Runner.run()` must propagate provider and transport failures by **throwing**, not by converting them into `{ type: 'error' }` steps. The orchestration layer (`runAgentOnCarve()` in `src/eval-runner.ts`) catches thrown runner errors and converts them into infrastructure failures via `createInfrastructureFailureResult()`.

Only provider-emitted stream items (e.g., an `error` event from the provider's event stream) should become `AgentStep` error events. SDK exceptions from the provider client (connection failures, auth errors, stream disconnects) should be rethrown so the orchestrator can handle them uniformly.

**Returned result inspection**: For SDKs that return a final result object after streaming (e.g., `const result = await client.run(...)`), inspect both the streamed events and the returned result. If the result indicates an error (e.g., `result.output.type === 'error'`), write a debug trace artifact even when the SDK did not throw. Preserve any streamed `AgentStep`s collected before the error.

## Event Normalization

Provider-native events must be mapped to `PrintModeEvent` types:

- **Shell/command execution** → `tool_call` with `toolName: 'shell'` + `tool_result` with output in `output: [{ type: 'json', value }]`. Do **not** put command output inside `tool_call.input` — downstream consumers (trace compressor, TUI) expect outputs in `tool_result`.
- **File changes** → `tool_call` with `toolName: 'file_change'`, `toolCallId: item.id`, and `input: { changes: item.changes }`. Do not rewrite file changes into synthetic shell commands — downstream traces and the TUI must distinguish patch application from real terminal execution.
- **MCP tool calls** → `toolName: 'mcp:<server>:<tool>'` with matching `tool_result`.
- **Text/messages** → `{ type: 'text', text }`.
- **Web search / external tool calls** → `tool_call` with `toolName: 'web_search'` (or appropriate name), `toolCallId`, and `input` containing the query/parameters. Do not silently drop search activity from `steps`.
- **Provider-internal events** (reasoning, todo lists) → skip.

## Existing Runners

Three runners exist: `ClaudeRunner` (`src/runners/claude.ts`), `CodexRunner` (`src/runners/codex.ts`), and `CodebuffRunner` (`src/runners/codebuff.ts`). Each wraps a different provider SDK and follows the standard lifecycle above. Refer to their source files for constructor signatures and API key configuration.

## Cost Estimation

When computing `totalCostUsd`, prefer the provider's authoritative cost data when available (e.g., credits used from session state, billing API). Fall back to token-based estimation only when the provider does not report cost directly.

For token-based estimation, be aware that some providers report `input_tokens` as a total that already includes `cached_input_tokens`. In that case, subtract cached tokens before applying the non-cached input rate, then add cached tokens at the cached rate. The default price table in a runner must match the runner's default model — do not hardcode rates for a different model family.

## External Session Correlation

When a provider exposes an SDK callback or event stream, use it as the source of truth for `steps[]` instead of reconstructing events from provider log folders. If a provider also writes logs to disk, correlate them with a provider session ID or unique run-scoped identifier. Never key by `path.basename(cwd)` — Evalbuff temp clones are always named `<tempDir>/repo` and multiple workers run concurrently, so basename collisions are guaranteed.

## Adding a New Runner

1. Create `src/runners/<name>.ts` implementing `Runner`.
2. Follow the base-SHA → run → `captureGitDiff()` lifecycle.
3. Map **all** provider event/item types to `PrintModeEvent` types (see Event Normalization above). Explicitly handle every item type the provider emits — do not silently drop types like web search or tool calls.
4. Propagate SDK/transport exceptions by throwing (see Error Propagation above). Inspect returned result objects for logical errors too (see Error Propagation above).
5. Compute `totalCostUsd` using the correct model's rates or provider cost data (see Cost Estimation above).
6. Export from `src/runners/index.ts`.
7. Use a single options-object constructor when more than 2–3 dependencies are needed (cwd, env, provider client, model config, logging toggles).
8. Add a credential-handling test verifying API key precedence (constructor option → environment variable → fallback).
