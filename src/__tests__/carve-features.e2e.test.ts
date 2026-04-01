/**
 * E2E test for the feature carver.
 *
 * Requires OPENAI_API_KEY to be set. Creates a small multi-file TypeScript
 * project with distinct features, then runs the Codex-based planner and carver.
 *
 * Run: bun test src/__tests__/carve-features.e2e.test.ts
 */
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { planFeatures, carveFeature } from '../carve-features'

import type { CarveCandidate, CarvedFeature } from '../carve-features'

const SKIP = !process.env.OPENAI_API_KEY

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
}

// --- Test repo files ---
// A small project with 3 clear features: math utils, string utils, and a greeter

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'test-project',
    version: '1.0.0',
    type: 'module',
  }, null, 2),

  'tsconfig.json': JSON.stringify({
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
  }, null, 2),

  'src/index.ts': `import { isPrime, factorial } from './math'
import { capitalize, slugify } from './strings'
import { greet, farewell } from './greeter'

// Main entry point — uses all three modules
console.log(greet('World'))
console.log(\`Is 17 prime? \${isPrime(17)}\`)
console.log(\`5! = \${factorial(5)}\`)
console.log(capitalize('hello world'))
console.log(slugify('Hello World!'))
console.log(farewell('World'))
`,

  'src/math.ts': `/**
 * Math utility functions.
 */

export function isPrime(n: number): boolean {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}

export function factorial(n: number): number {
  if (n < 0) throw new Error('Factorial not defined for negative numbers')
  if (n <= 1) return 1
  return n * factorial(n - 1)
}

export function gcd(a: number, b: number): number {
  while (b !== 0) {
    ;[a, b] = [b, a % b]
  }
  return Math.abs(a)
}

export function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b)
}
`,

  'src/strings.ts': `/**
 * String utility functions.
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

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

export function countWords(str: string): number {
  return str.trim().split(/\\s+/).filter(Boolean).length
}
`,

  'src/greeter.ts': `/**
 * Greeting utilities with configurable templates.
 */

export interface GreetOptions {
  prefix?: string
  suffix?: string
  uppercase?: boolean
}

export function greet(name: string, options: GreetOptions = {}): string {
  const { prefix = 'Hello', suffix = '!', uppercase = false } = options
  const msg = \`\${prefix}, \${name}\${suffix}\`
  return uppercase ? msg.toUpperCase() : msg
}

export function farewell(name: string): string {
  return \`Goodbye, \${name}. See you next time!\`
}

export function formatGreeting(names: string[]): string {
  if (names.length === 0) return 'Hello!'
  if (names.length === 1) return greet(names[0])
  const last = names[names.length - 1]
  const rest = names.slice(0, -1).join(', ')
  return \`Hello, \${rest} and \${last}!\`
}
`,

  'src/math.test.ts': `import { isPrime, factorial, gcd, lcm } from './math'

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(\`Assertion failed: \${msg}\`)
}

// isPrime tests
assert(isPrime(2) === true, 'isPrime(2)')
assert(isPrime(3) === true, 'isPrime(3)')
assert(isPrime(4) === false, 'isPrime(4)')
assert(isPrime(17) === true, 'isPrime(17)')
assert(isPrime(1) === false, 'isPrime(1)')
assert(isPrime(0) === false, 'isPrime(0)')

// factorial tests
assert(factorial(0) === 1, 'factorial(0)')
assert(factorial(1) === 1, 'factorial(1)')
assert(factorial(5) === 120, 'factorial(5)')

// gcd tests
assert(gcd(12, 8) === 4, 'gcd(12,8)')
assert(gcd(7, 13) === 1, 'gcd(7,13)')

// lcm tests
assert(lcm(4, 6) === 12, 'lcm(4,6)')

console.log('All math tests passed!')
`,

  'src/strings.test.ts': `import { capitalize, slugify, truncate, countWords } from './strings'

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(\`Assertion failed: \${msg}\`)
}

assert(capitalize('hello world') === 'Hello World', 'capitalize')
assert(slugify('Hello World!') === 'hello-world', 'slugify')
assert(truncate('hello world', 8) === 'hello...', 'truncate')
assert(countWords('one two three') === 3, 'countWords')

console.log('All string tests passed!')
`,
}

// --- Helpers ---

let repoDir: string

function createTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carve-e2e-'))

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
})

afterAll(() => {
  if (repoDir) {
    // Clean up any leftover worktrees
    try {
      execSync('git worktree prune', { cwd: repoDir, stdio: 'ignore' })
    } catch { /* ignore */ }
    fs.rmSync(repoDir, { recursive: true, force: true })
  }
})

// --- Tests ---

describe('Feature carver e2e', () => {
  let plan: Awaited<ReturnType<typeof planFeatures>>

  it.skipIf(SKIP)(
    'plans features to carve from the test repo',
    async () => {
      plan = await planFeatures(repoDir)

      console.log(`Plan reasoning: ${plan.reasoning.slice(0, 300)}`)
      console.log(`Candidates: ${plan.candidates.length}`)
      for (const c of plan.candidates) {
        console.log(`  ${c.id} (${c.complexity}): ${c.name}`)
      }

      expect(plan.candidates.length).toBeGreaterThanOrEqual(2)

      for (const c of plan.candidates) {
        expect(c.id).toBeString()
        expect(c.name).toBeString()
        expect(c.prompt).toBeString()
        expect(c.description).toBeString()
        expect(c.files).toBeArray()
        expect(c.files.length).toBeGreaterThan(0)
        expect(['small', 'medium', 'large']).toContain(c.complexity)
      }
    },
    5 * 60_000,
  )

  it.skipIf(SKIP)(
    'carves the first 2 planned features with valid diffs',
    async () => {
      expect(plan).toBeDefined()
      expect(plan.candidates.length).toBeGreaterThanOrEqual(2)

      const toCarve = plan.candidates.slice(0, 2)
      const carved: CarvedFeature[] = []

      for (const candidate of toCarve) {
        console.log(`\nCarving: ${candidate.id}`)
        const result = await carveFeature(repoDir, candidate)

        if (result) {
          carved.push(result)
          console.log(`  Result: ${result.operations.length} operations, ${result.diff.split('\n').length} diff lines`)
          console.log(`  Original files: ${Object.keys(result.originalFiles).join(', ')}`)
        } else {
          console.log(`  Skipped (no changes)`)
        }
      }

      expect(carved.length).toBeGreaterThanOrEqual(1)

      for (const feature of carved) {
        // Has a valid diff
        expect(feature.diff).toBeString()
        expect(feature.diff.length).toBeGreaterThan(0)
        expect(feature.diff).toContain('diff --git')

        // Has operations
        expect(feature.operations.length).toBeGreaterThan(0)
        for (const op of feature.operations) {
          expect(op.path).toBeString()
          expect(['delete', 'modify']).toContain(op.action)
          if (op.action === 'modify') {
            expect(op.newContent).toBeString()
          }
        }

        // Has original files saved
        expect(Object.keys(feature.originalFiles).length).toBeGreaterThan(0)

        // Metadata is preserved
        expect(feature.id).toBeString()
        expect(feature.prompt).toBeString()
        expect(feature.description).toBeString()
      }

      // Verify the original repo is untouched
      const status = execSync('git status --porcelain', {
        cwd: repoDir,
        encoding: 'utf-8',
      })
      expect(status.trim()).toBe('')

      // Verify no leftover worktrees
      const worktrees = execSync('git worktree list', {
        cwd: repoDir,
        encoding: 'utf-8',
      })
      const worktreeLines = worktrees.trim().split('\n')
      expect(worktreeLines.length).toBe(1) // only the main worktree
    },
    10 * 60_000,
  )
})
