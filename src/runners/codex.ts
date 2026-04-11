import { execSync } from 'child_process'

import { Codex } from '@openai/codex-sdk'
import { captureGitDiff } from '../eval-helpers'

import type { Runner, RunnerResult, AgentStep } from './runner'
import type { ThreadItem, Usage } from '@openai/codex-sdk'

export class CodexRunner implements Runner {
  private cwd: string
  private env: Record<string, string>

  constructor(cwd: string, env: Record<string, string> = {}) {
    this.cwd = cwd
    this.env = env
  }

  async run(prompt: string): Promise<RunnerResult> {
    const steps: AgentStep[] = []
    const baseSha = execSync('git rev-parse HEAD', {
      cwd: this.cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()

    const codex = new Codex({
      apiKey: process.env.OPENAI_API_KEY || this.env.OPENAI_API_KEY,
    })

    const thread = codex.startThread({
      model: 'gpt-5.4',
      workingDirectory: this.cwd,
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      webSearchMode: 'live',
    })

    const { events } = await thread.runStreamed(prompt)
    let usage: Usage | null = null

    for await (const event of events) {
      switch (event.type) {
        case 'item.completed':
          processItem(event.item, steps)
          break
        case 'turn.completed':
          usage = event.usage
          break
        case 'turn.failed':
          console.error(`[codex-runner] Turn failed:`, event.error.message)
          steps.push({
            type: 'text',
            text: `[ERROR] Codex turn failed: ${event.error.message}`,
          })
          break
        case 'error':
          console.error(`[codex-runner] Stream error:`, event.message)
          steps.push({
            type: 'text',
            text: `[ERROR] Codex stream error: ${event.message}`,
          })
          break
      }
    }

    // Get git diff after Codex has made changes
    let diff = ''
    try {
      diff = captureGitDiff(this.cwd, { baseRef: baseSha })
    } catch (error) {
      console.error(
        `[codex-runner] Failed to capture git diff:`,
        error instanceof Error ? error.message : error,
      )
    }

    // Estimate cost from token usage (rough GPT-5.1-codex pricing)
    const totalCostUsd = usage
      ? (usage.input_tokens * 2 + usage.output_tokens * 8) / 1_000_000
      : 0

    return {
      steps,
      totalCostUsd,
      diff,
    }
  }
}

function processItem(item: ThreadItem, steps: AgentStep[]): void {
  switch (item.type) {
    case 'agent_message':
      steps.push({ type: 'text', text: item.text })
      break
    case 'command_execution':
      steps.push({
        type: 'tool_call',
        toolName: 'shell',
        toolCallId: item.id,
        input: { command: item.command },
      })
      if (item.aggregated_output) {
        steps.push({
          type: 'tool_result',
          toolName: 'shell',
          toolCallId: item.id,
          output: [{ type: 'json', value: item.aggregated_output }],
        })
      }
      break
    case 'file_change':
      steps.push({
        type: 'tool_call',
        toolName: 'file_change',
        toolCallId: item.id,
        input: { changes: item.changes },
      })
      break
    case 'mcp_tool_call':
      steps.push({
        type: 'tool_call',
        toolName: `mcp:${item.server}:${item.tool}`,
        toolCallId: item.id,
        input: item.arguments as Record<string, any>,
      })
      if (item.result || item.error) {
        steps.push({
          type: 'tool_result',
          toolName: `mcp:${item.server}:${item.tool}`,
          toolCallId: item.id,
          output: [{ type: 'json', value: item.result || item.error }],
        })
      }
      break
    case 'web_search':
      steps.push({
        type: 'tool_call',
        toolName: 'web_search',
        toolCallId: item.id,
        input: { query: item.query },
      })
      break
    case 'reasoning':
      // Skip reasoning items, they're internal
      break
    case 'todo_list':
      // Skip todo lists
      break
    case 'error':
      console.error(`[codex-runner] Item error:`, item)
      steps.push({
        type: 'text',
        text: `[ERROR] Codex item error: ${'message' in item ? (item as any).message : JSON.stringify(item)}`,
      })
      break
  }
}
