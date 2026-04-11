import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, it } from 'bun:test'

import { runAgentOnCarve } from '../eval-runner'

import type { CarvedFeature } from '../carve-features'

describe('runAgentOnCarve', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const tempPath of tempPaths.splice(0)) {
      try {
        fs.rmSync(tempPath, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures
      }
    }
  })

  it('returns score -1 for infrastructure failures before the agent ever runs', async () => {
    const feature: CarvedFeature = {
      id: 'broken-repo',
      prompt: 'Restore the broken feature',
      description: 'A feature used to verify infra-failure handling',
      complexity: 'small',
      originalFiles: {},
      operations: [],
      diff: 'diff --git a/a b/a\n',
    }

    const result = await runAgentOnCarve({
      idx: 0,
      total: 1,
      repoPath: '/tmp/evalbuff-repo-that-does-not-exist',
      feature,
      model: 'sonnet',
      groundTruthDiff: feature.diff,
      docsSourcePath: '/tmp/evalbuff-repo-that-does-not-exist',
    })

    expect(result.score).toBe(-1)
    expect(result.judging.overallScore).toBe(-1)
    expect(result.trace).toContain('Agent error:')
    expect(result.diff).toBe('')
  })

  it('preserves the runner diff when the agent commits changes during the run', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-eval-runner-test-'))
    tempPaths.push(repoPath)

    fs.mkdirSync(path.join(repoPath, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true })
    fs.writeFileSync(path.join(repoPath, 'AGENTS.md'), '# Test repo\n')
    fs.writeFileSync(path.join(repoPath, 'docs', 'guide.md'), '# Guide\n')
    fs.writeFileSync(path.join(repoPath, 'src', 'feature.ts'), 'export const carved = false\n')

    execSync('git init', { cwd: repoPath, stdio: 'ignore' })
    execSync('git config user.name "Evalbuff Tests"', { cwd: repoPath, stdio: 'ignore' })
    execSync('git config user.email "evalbuff@example.com"', { cwd: repoPath, stdio: 'ignore' })
    execSync('git add -A', { cwd: repoPath, stdio: 'ignore' })
    execSync('git commit -m "initial"', { cwd: repoPath, stdio: 'ignore' })

    let judgedDiff = ''
    const expectedDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+restored\n'

    const feature: CarvedFeature = {
      id: 'committed-feature',
      prompt: 'Restore the feature',
      description: 'A feature used to verify diff preservation',
      complexity: 'small',
      originalFiles: {},
      operations: [],
      diff: expectedDiff,
    }

    const result = await runAgentOnCarve(
      {
        idx: 0,
        total: 1,
        repoPath,
        feature,
        model: 'sonnet',
        groundTruthDiff: expectedDiff,
        docsSourcePath: repoPath,
      },
      {
        createRunner: (repoDir) => ({
          run: async () => {
            fs.writeFileSync(path.join(repoDir, 'src', 'feature.ts'), 'export const carved = true\n')
            execSync('git add -A', { cwd: repoDir, stdio: 'ignore' })
            execSync('git commit -m "agent change"', { cwd: repoDir, stdio: 'ignore' })

            return {
              steps: [],
              totalCostUsd: 1.25,
              diff: expectedDiff,
            }
          },
        }),
        buildCodingAgentPrompt: (prompt) => prompt,
        judgeTaskResult: async ({ agentDiff }) => {
          judgedDiff = agentDiff
          return {
            analysis: 'ok',
            strengths: [],
            weaknesses: [],
            e2eTestsPerformed: [],
            completionScore: 7,
            codeQualityScore: 7,
            e2eScore: 7,
            overallScore: 7,
          }
        },
        readCodingAgentSuggestions: () => ({
          docSuggestions: [],
          projectSuggestions: [],
        }),
      },
    )

    expect(result.diff).toBe(expectedDiff)
    expect(judgedDiff).toBe(expectedDiff)
    expect(result.score).toBe(7)
  })
})
