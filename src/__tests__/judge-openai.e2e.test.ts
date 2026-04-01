/**
 * E2E test for the Codex SDK judge.
 *
 * Requires OPENAI_API_KEY to be set. Creates a temp git repo, runs the
 * Codex-based judge with a simple diff, and validates the result schema.
 *
 * Run: bun test src/__tests__/judge-openai.e2e.test.ts
 */
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { judgeTaskResult } from '../judge'

import type { JudgingResult } from '../judge'

const SKIP = !process.env.OPENAI_API_KEY

let repoDir: string

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
}

const BASE_FILE = 'export function add(a: number, b: number) { return a + b }\n'

const FULL_FILE = `export function add(a: number, b: number) { return a + b }

export function isPrime(n: number): boolean {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
`

const GROUND_TRUTH_DIFF = `
diff --git a/math.ts b/math.ts
--- a/math.ts
+++ b/math.ts
@@ -1 +1,8 @@
 export function add(a: number, b: number) { return a + b }
+
+export function isPrime(n: number): boolean {
+  if (n <= 1) return false
+  for (let i = 2; i * i <= n; i++) {
+    if (n % i === 0) return false
+  }
+  return true
+}`

function createRepo(withIsPrime: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-e2e-'))
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: dir, stdio: 'ignore', env: GIT_ENV,
  })
  fs.writeFileSync(path.join(dir, 'math.ts'), BASE_FILE)
  execSync('git add . && git commit -m "add math.ts"', {
    cwd: dir, stdio: 'ignore', env: GIT_ENV,
  })
  if (withIsPrime) {
    // Apply the agent's changes to the actual repo so the Codex reviewer
    // can verify them end-to-end
    fs.writeFileSync(path.join(dir, 'math.ts'), FULL_FILE)
    execSync('git add . && git commit -m "add isPrime"', {
      cwd: dir, stdio: 'ignore', env: GIT_ENV,
    })
  }
  return dir
}

beforeAll(() => {
  if (SKIP) return
  // Create two repos: one with the change applied, one without
  repoDir = createRepo(false)
})

afterAll(() => {
  if (repoDir) {
    fs.rmSync(repoDir, { recursive: true, force: true })
  }
})

function validateResult(result: JudgingResult) {
  expect(result.analysis).toBeString()
  expect(result.analysis.length).toBeGreaterThan(0)
  expect(result.strengths).toBeArray()
  expect(result.weaknesses).toBeArray()
  expect(result.e2eTestsPerformed).toBeArray()

  for (const key of ['completionScore', 'codeQualityScore', 'e2eScore', 'overallScore'] as const) {
    expect(result[key]).toBeGreaterThanOrEqual(0)
    expect(result[key]).toBeLessThanOrEqual(10)
  }
}

describe('Codex SDK judge e2e', () => {
  it.skipIf(SKIP)(
    'scores a near-perfect diff high when changes are applied to repo',
    async () => {
      // Create a repo WITH the isPrime function applied
      const goodRepo = createRepo(true)
      try {
        const result = await judgeTaskResult({
          taskPrompt: 'Add an isPrime function to math.ts',
          groundTruthDiff: GROUND_TRUTH_DIFF,
          agentDiff: GROUND_TRUTH_DIFF,
          repoDir: goodRepo,
          reviewerAgents: ['codex'], // Single reviewer for speed
        })

        console.log('Near-perfect result:', JSON.stringify(result, null, 2))
        validateResult(result)
        expect(result.overallScore).toBeGreaterThanOrEqual(7)
      } finally {
        fs.rmSync(goodRepo, { recursive: true, force: true })
      }
    },
    5 * 60_000, // 5 min timeout for codex agent
  )

  it.skipIf(SKIP)(
    'scores an empty diff low when no changes in repo',
    async () => {
      const result = await judgeTaskResult({
        taskPrompt: 'Add an isPrime function to math.ts',
        groundTruthDiff: GROUND_TRUTH_DIFF,
        agentDiff: '',
        repoDir,
        reviewerAgents: ['codex'],
      })

      console.log('Empty diff result:', JSON.stringify(result, null, 2))
      validateResult(result)
      expect(result.overallScore).toBeLessThanOrEqual(3)
    },
    5 * 60_000,
  )
})
