/**
 * E2E test for the docs writer.
 *
 * Creates a small repo with docs and config-driven CLI code, then runs the
 * real docs writer agent to plan independent documentation changes from a set
 * of suggestions. Verifies that broadly useful guidance is accepted as a
 * reusable patch and that an obviously task-specific suggestion is rejected.
 *
 * Requires CLAUDE_CODE_KEY or ANTHROPIC_API_KEY.
 *
 * Run: bun test src/__tests__/docs-writer.e2e.test.ts
 */
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { describe, expect, it } from 'bun:test'

import {
  cleanupDraftedDocsChange,
  cleanupPlannedDocsTaskResult,
  materializeDocsChangeFromPatch,
  planDocsChangesForTask,
} from '../docs-writer'

import type { IndependentSuggestion } from '../docs-writer'

const SKIP = !(process.env.CLAUDE_CODE_KEY || process.env.ANTHROPIC_API_KEY)

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
}

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'evalbuff-docs-writer-test-project',
      version: '1.0.0',
      type: 'module',
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
      include: ['src'],
    },
    null,
    2,
  ),
  'AGENTS.md': `# Test Repo

## Docs Index

- docs/architecture.md
- docs/testing.md
`,
  'docs/architecture.md': `# Architecture

This repo exposes a small CLI.
Configuration is read from source files under src/.
`,
  'docs/testing.md': `# Testing

Run \`bun test\` for unit tests.
`,
  'src/config.ts': `export interface AppConfig {
  mode: 'dev' | 'test'
  cacheDir: string
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return {
    mode: env.APP_MODE === 'test' ? 'test' : 'dev',
    cacheDir: env.APP_CACHE_DIR || '.cache/app',
  }
}
`,
  'src/cli.ts': `import { loadConfig } from './config'

export function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): string {
  const config = loadConfig(env)
  if (args.includes('--print-config')) {
    return \`\${config.mode}:\${config.cacheDir}\`
  }
  return 'ok'
}
`,
  'src/cli.test.ts': `import { runCli } from './cli'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(runCli(['--print-config'], {
  APP_MODE: 'test',
  APP_CACHE_DIR: '/tmp/evalbuff-docs-writer-test',
}) === 'test:/tmp/evalbuff-docs-writer-test', 'print-config uses env-driven config')
`,
}

function createTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-docs-writer-e2e-'))
  execSync('git init', { cwd: dir, stdio: 'ignore', env: GIT_ENV })

  for (const [relativePath, content] of Object.entries(FILES)) {
    const fullPath = path.join(dir, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }

  execSync('git add -A && git commit -m "Initial commit"', {
    cwd: dir,
    stdio: 'ignore',
    env: GIT_ENV,
  })

  return dir
}

describe('docs writer e2e', () => {
  it.skipIf(SKIP)(
    'plans reusable docs changes and rejects an overfit suggestion with the real agent',
    async () => {
      const repoDir = createTestRepo()
      let completed = false
      let plannedResult: Awaited<ReturnType<typeof planDocsChangesForTask>> | null = null
      let materializedDraft: ReturnType<typeof materializeDocsChangeFromPatch> | null = null

      try {
        console.log(`Docs writer test repo: ${repoDir}`)

        const suggestions: IndependentSuggestion[] = [
          {
            source: 'judge',
            priority: 85,
            text: 'Update docs/testing.md to explain that tests and CLI flows touching src/config.ts should set APP_MODE=test and APP_CACHE_DIR explicitly, because loadConfig() reads both values from environment variables and src/cli.ts uses that config at runtime. This is a reusable setup rule for any config-sensitive task.',
          },
          {
            source: 'agent',
            priority: 80,
            text: 'Create a docs file that explains how to rebuild the --print-config branch in src/cli.ts line-by-line, including the exact output formatting and argument order for this one task.',
          },
        ]

        plannedResult = await planDocsChangesForTask(repoDir, suggestions, 'sonnet')
        expect(plannedResult).toBeDefined()
        if (!plannedResult) {
          throw new Error('docs writer did not return a plan')
        }

        expect(plannedResult.candidates.length).toBeGreaterThanOrEqual(2)

        const accepted = plannedResult.candidates.find((candidate) =>
          candidate.text.includes('APP_MODE=test and APP_CACHE_DIR explicitly'),
        )
        expect(accepted).toBeDefined()
        if (!accepted) {
          throw new Error('missing accepted candidate')
        }

        expect(accepted.accepted).toBe(true)
        expect(accepted.overfit).toBe(false)
        expect(accepted.branchName).toBeString()
        expect(accepted.commitSha).toBeString()
        expect(accepted.patchText).toContain('docs/')
        expect(accepted.diffText).toContain('APP_MODE')

        materializedDraft = materializeDocsChangeFromPatch(repoDir, accepted.patchText || '')
        expect(materializedDraft).toBeDefined()
        if (!materializedDraft) {
          throw new Error('failed to materialize accepted docs patch')
        }
        expect(materializedDraft.diffText).toContain('APP_CACHE_DIR')

        const rejected = plannedResult.candidates.find((candidate) =>
          candidate.text.includes('line-by-line'),
        )
        expect(rejected).toBeDefined()
        if (!rejected) {
          throw new Error('missing rejected candidate')
        }

        expect(rejected.accepted).toBe(false)
        expect(rejected.overfit || rejected.reason.toLowerCase().includes('overfit')).toBe(true)
        expect(rejected.branchName).toBeUndefined()
        expect(rejected.commitSha).toBeUndefined()

        const status = execSync('git status --short', {
          cwd: repoDir,
          encoding: 'utf-8',
        }).trim()
        expect(status).toBe('')

        const worktrees = execSync('git worktree list', {
          cwd: repoDir,
          encoding: 'utf-8',
        }).trim().split('\n')
        expect(worktrees.length).toBe(1)

        completed = true
      } finally {
        if (completed) {
          if (materializedDraft) cleanupDraftedDocsChange(materializedDraft)
          if (plannedResult) cleanupPlannedDocsTaskResult(plannedResult)
          fs.rmSync(repoDir, { recursive: true, force: true })
        } else {
          console.log(`Preserving docs writer test repo for debugging: ${repoDir}`)
          if (plannedResult) {
            console.log(`Preserving docs writer temp clone: ${plannedResult.tempDir}`)
          }
          if (materializedDraft) {
            console.log(`Preserving materialized docs clone: ${materializedDraft.tempDir}`)
          }
        }
      }
    },
    30 * 60_000,
  )
})
