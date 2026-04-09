/**
 * E2E test for the full evalbuff pipeline.
 *
 * Creates a small test repo with distinct features, then runs the complete
 * eval loop: plan → carve → baseline eval (Claude agent + Codex judge) →
 * improvement loop (docs writer + re-eval).
 *
 * Requires OPENAI_API_KEY and either CLAUDE_CODE_KEY or ANTHROPIC_API_KEY.
 *
 * Run: bun test src/__tests__/run-evalbuff.e2e.test.ts
 */
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { runEvalbuff } from '../run-evalbuff'

const SKIP =
  !process.env.OPENAI_API_KEY ||
  !(process.env.CLAUDE_CODE_KEY || process.env.ANTHROPIC_API_KEY)

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
}

// ---------------------------------------------------------------------------
// Test repo: a small Express-style TypeScript project with 4 distinct features
// ---------------------------------------------------------------------------

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'evalbuff-test-project',
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
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ['src'],
    },
    null,
    2,
  ),

  'src/index.ts': `import { add, multiply, fibonacci } from './math'
import { capitalize, slugify, reverse } from './strings'
import { Stack } from './stack'
import { formatDate, daysUntil } from './dates'

// Main entry — exercises all four modules
console.log('Math:', add(2, 3), multiply(4, 5), fibonacci(10))
console.log('Strings:', capitalize('hello world'), slugify('Hello World!'), reverse('abc'))

const s = new Stack<number>()
s.push(1)
s.push(2)
console.log('Stack:', s.peek(), s.size())

console.log('Dates:', formatDate(new Date(2025, 0, 1)), daysUntil(new Date(2025, 11, 31)))
`,

  'src/math.ts': `/**
 * Math utilities — arithmetic and sequences.
 */

export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}

export function fibonacci(n: number): number {
  if (n <= 0) return 0
  if (n === 1) return 1
  let a = 0, b = 1
  for (let i = 2; i <= n; i++) {
    ;[a, b] = [b, a + b]
  }
  return b
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
`,

  'src/strings.ts': `/**
 * String transformation utilities.
 */

export function capitalize(str: string): string {
  return str.replace(/\\b\\w/g, (c) => c.toUpperCase())
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function reverse(str: string): string {
  return str.split('').reverse().join('')
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}
`,

  'src/stack.ts': `/**
 * Generic stack data structure.
 */

export class Stack<T> {
  private items: T[] = []

  push(item: T): void {
    this.items.push(item)
  }

  pop(): T | undefined {
    return this.items.pop()
  }

  peek(): T | undefined {
    return this.items[this.items.length - 1]
  }

  size(): number {
    return this.items.length
  }

  isEmpty(): boolean {
    return this.items.length === 0
  }

  toArray(): T[] {
    return [...this.items]
  }
}
`,

  'src/dates.ts': `/**
 * Date formatting and calculation utilities.
 */

export function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return \`\${y}-\${m}-\${d}\`
}

export function daysUntil(target: Date): number {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const t = new Date(target)
  t.setHours(0, 0, 0, 0)
  return Math.ceil((t.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}
`,

  'src/math.test.ts': `import { add, multiply, fibonacci, clamp } from './math'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(\`Assertion failed: \${msg}\`)
}

assert(add(2, 3) === 5, 'add(2,3)')
assert(multiply(4, 5) === 20, 'multiply(4,5)')
assert(fibonacci(10) === 55, 'fibonacci(10)')
assert(fibonacci(0) === 0, 'fibonacci(0)')
assert(clamp(15, 0, 10) === 10, 'clamp high')
assert(clamp(-5, 0, 10) === 0, 'clamp low')
assert(clamp(5, 0, 10) === 5, 'clamp mid')

console.log('All math tests passed!')
`,

  'src/strings.test.ts': `import { capitalize, slugify, reverse, truncate } from './strings'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(\`Assertion failed: \${msg}\`)
}

assert(capitalize('hello world') === 'Hello World', 'capitalize')
assert(slugify('Hello World!') === 'hello-world', 'slugify')
assert(reverse('abc') === 'cba', 'reverse')
assert(truncate('hello world', 8) === 'hello...', 'truncate')

console.log('All string tests passed!')
`,

  'src/stack.test.ts': `import { Stack } from './stack'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(\`Assertion failed: \${msg}\`)
}

const s = new Stack<number>()
assert(s.isEmpty(), 'isEmpty initially')
s.push(1)
s.push(2)
s.push(3)
assert(s.size() === 3, 'size after push')
assert(s.peek() === 3, 'peek top')
assert(s.pop() === 3, 'pop top')
assert(s.size() === 2, 'size after pop')
assert(JSON.stringify(s.toArray()) === '[1,2]', 'toArray')

console.log('All stack tests passed!')
`,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let repoDir: string

function createTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-e2e-'))

  execSync('git init', { cwd: dir, stdio: 'ignore', env: GIT_ENV })

  for (const [filePath, content] of Object.entries(FILES)) {
    const fullPath = path.join(dir, filePath)
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

beforeAll(() => {
  if (SKIP) return
  repoDir = createTestRepo()
  console.log(`Test repo created at: ${repoDir}`)
})

afterAll(() => {
  if (repoDir) {
    try {
      execSync('git worktree prune', { cwd: repoDir, stdio: 'ignore' })
    } catch {
      /* ignore */
    }
    fs.rmSync(repoDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Evalbuff pipeline e2e', () => {
  it.skipIf(SKIP)(
    'runs the full evalbuff pipeline: plan → carve → eval → docs loop → re-eval',
    async () => {
      const tmpDir = os.tmpdir()
      const existingLogDirs = new Set(
        fs.readdirSync(tmpDir).filter((entry) => entry.startsWith('evalbuff-run-')),
      )

      // Use minimal settings: 2 features and the default single improvement round
      await runEvalbuff({
        repoPath: repoDir,
        n: 2,
        codingModel: 'sonnet',
        docsModel: 'sonnet', // use sonnet for speed in tests
      })

      // Find the new log directory in the temp dir.
      const logDirName = fs
        .readdirSync(tmpDir)
        .filter((entry) => entry.startsWith('evalbuff-run-') && !existingLogDirs.has(entry))
        .sort()
        .at(-1)
      expect(logDirName).toBeDefined()

      const logDir = path.join(tmpDir, logDirName!)
      console.log(`Log directory: ${logDir}`)

      // --- Verify plan was saved ---
      const planPath = path.join(logDir, 'plan.json')
      expect(fs.existsSync(planPath)).toBe(true)
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
      expect(plan.candidates).toBeArray()
      expect(plan.candidates.length).toBeGreaterThanOrEqual(2)
      console.log(`Plan: ${plan.candidates.length} candidates identified`)

      // --- Verify features were carved ---
      const featuresPath = path.join(logDir, 'features.json')
      expect(fs.existsSync(featuresPath)).toBe(true)
      const features = JSON.parse(fs.readFileSync(featuresPath, 'utf-8'))
      expect(features).toBeArray()
      expect(features.length).toBeGreaterThanOrEqual(1)
      for (const f of features) {
        expect(f.id).toBeString()
        expect(f.prompt).toBeString()
        expect(f.diff).toBeString()
        expect(f.operations).toBeArray()
        expect(f.operations.length).toBeGreaterThan(0)
      }
      console.log(`Carved ${features.length} features: ${features.map((f: any) => f.id).join(', ')}`)

      // --- Verify baseline round (round-0) ---
      const round0Dir = path.join(logDir, 'round-0')
      expect(fs.existsSync(round0Dir)).toBe(true)

      const round0Summary = JSON.parse(
        fs.readFileSync(path.join(round0Dir, 'summary.json'), 'utf-8'),
      )
      expect(round0Summary.round).toBe(0)
      expect(round0Summary.tasks).toBeArray()
      expect(round0Summary.tasks.length).toBeGreaterThanOrEqual(1)
      console.log(`Baseline round: avg score ${round0Summary.avgScore.toFixed(1)}, ${round0Summary.tasks.length} tasks`)

      // Verify per-task artifacts exist
      for (const task of round0Summary.tasks) {
        const taskDir = path.join(round0Dir, task.featureId)
        expect(fs.existsSync(taskDir)).toBe(true)
        expect(fs.existsSync(path.join(taskDir, 'trace.txt'))).toBe(true)
        expect(fs.existsSync(path.join(taskDir, 'diff.txt'))).toBe(true)
        expect(fs.existsSync(path.join(taskDir, 'judging.json'))).toBe(true)
        expect(fs.existsSync(path.join(taskDir, 'score.txt'))).toBe(true)

        // Verify judging result structure
        const judging = JSON.parse(
          fs.readFileSync(path.join(taskDir, 'judging.json'), 'utf-8'),
        )
        expect(judging).toHaveProperty('analysis')
        expect(judging).toHaveProperty('overallScore')
        expect(judging).toHaveProperty('completionScore')
        expect(judging).toHaveProperty('codeQualityScore')
        expect(judging).toHaveProperty('e2eScore')
        expect(judging).toHaveProperty('strengths')
        expect(judging).toHaveProperty('weaknesses')
        console.log(`  ${task.featureId}: score ${task.score}`)
      }

      // --- Verify improvement loop (round-1) ---
      const round1Dir = path.join(logDir, 'round-1')
      expect(fs.existsSync(round1Dir)).toBe(true)

      const round1Summary = JSON.parse(
        fs.readFileSync(path.join(round1Dir, 'summary.json'), 'utf-8'),
      )
      expect(round1Summary.round).toBe(1)
      expect(round1Summary.tasks).toBeArray()
      console.log(`Loop 1 round: avg score ${round1Summary.avgScore.toFixed(1)}, ${round1Summary.tasks.length} tasks`)

      // --- Verify docs writer artifacts ---
      const judgeSuggestionsPath = path.join(logDir, 'judge-suggestions-loop-1.txt')
      expect(fs.existsSync(judgeSuggestionsPath)).toBe(true)

      const docsDiffPath = path.join(logDir, 'docs-diff-loop-1.txt')
      expect(fs.existsSync(docsDiffPath)).toBe(true)

      const docsStatePath = path.join(logDir, 'docs-state-loop-1.json')
      expect(fs.existsSync(docsStatePath)).toBe(true)

      const docGatesPath = path.join(logDir, 'doc-gates-loop-1.json')
      expect(fs.existsSync(docGatesPath)).toBe(true)

      // --- Verify overall summary ---
      const summaryPath = path.join(logDir, 'summary.json')
      expect(fs.existsSync(summaryPath)).toBe(true)
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
      expect(summary.repoPath).toBe(repoDir)
      expect(summary.featuresCarved).toBeGreaterThanOrEqual(1)
      expect(summary.rounds).toBeArray()
      expect(summary.rounds.length).toBe(2) // baseline + 1 loop
      expect(summary.scoreProgression).toBeArray()
      expect(summary.scoreProgression.length).toBe(2)
      expect(summary.totalCost).toBeGreaterThanOrEqual(0)
      console.log(`Score progression: ${summary.scoreProgression.map((s: number) => s.toFixed(1)).join(' → ')}`)
      console.log(`Total cost: $${summary.totalCost.toFixed(2)}`)

      // --- Verify final report ---
      const reportPath = path.join(logDir, 'report.md')
      expect(fs.existsSync(reportPath)).toBe(true)
      const report = fs.readFileSync(reportPath, 'utf-8')
      expect(report).toContain('Evalbuff Run Report')
      expect(report).toContain('Score Trajectory')
      expect(report).toContain('Scores by Round')
      expect(report).toContain('Baseline')
      console.log(`Report written: ${report.split('\n').length} lines`)

      // --- Verify the original repo is still clean (no leftover worktrees) ---
      const worktrees = execSync('git worktree list', {
        cwd: repoDir,
        encoding: 'utf-8',
      })
      const worktreeLines = worktrees.trim().split('\n')
      expect(worktreeLines.length).toBe(1) // only the main worktree
    },
    60 * 60_000, // 60 minute timeout — this runs real agents
  )
})
