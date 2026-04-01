import { execSync } from 'child_process'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { captureGitDiff } from '../eval-helpers'

import type { Runner, RunnerResult, AgentStep } from './runner'

export class ClaudeRunner implements Runner {
  private cwd: string
  private env: Record<string, string>
  private model: string
  private effort?: string

  constructor(
    cwd: string,
    env: Record<string, string> = {},
    model: string = 'claude-opus-4-5-20251101',
    effort?: string,
  ) {
    this.cwd = cwd
    this.env = env
    this.model = model
    this.effort = effort
  }

  async run(prompt: string): Promise<RunnerResult> {
    const steps: AgentStep[] = []
    let totalCostUsd = 0
    const baseSha = execSync('git rev-parse HEAD', {
      cwd: this.cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()

    console.log(`[ClaudeRunner] Running with model ${this.model} in ${this.cwd}`)

    const session = query({
      prompt,
      options: {
        cwd: this.cwd,
        model: this.model,
        effort: (this.effort as any) || 'high',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        env: {
          ...process.env as Record<string, string>,
          ...this.env,
          ANTHROPIC_API_KEY:
            process.env.CLAUDE_CODE_KEY || process.env.ANTHROPIC_API_KEY || '',
        },
      },
    })

    for await (const message of session) {
      if (message.type === 'assistant') {
        const content = message.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              steps.push({ type: 'text', text: block.text })
              process.stdout.write(block.text)
            } else if (block.type === 'tool_use') {
              steps.push({
                type: 'tool_call',
                toolName: block.name,
                toolCallId: block.id,
                input: (block.input as Record<string, any>) || {},
              })
            }
          }
        }
      } else if (message.type === 'result') {
        totalCostUsd = message.total_cost_usd || 0
      }
    }

    // Get git diff after Claude has made changes
    let diff = ''
    try {
      diff = captureGitDiff(this.cwd, { baseRef: baseSha })
    } catch {
      // Ignore git errors
    }

    return {
      steps,
      totalCostUsd,
      diff,
    }
  }
}
