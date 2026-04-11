import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_TEST_REPOS_ROOT = path.join(REPO_ROOT, 'test-repos')
export const FIXTURE_LAYOUT_VERSION = 1
export const FIXTURE_METADATA_FILENAME = 'evalbuff-fixture.json'
export const FIXTURE_MANIFEST_FILENAME = 'manifest.json'

const FIXTURE_COMMIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Evalbuff Fixtures',
  GIT_AUTHOR_EMAIL: 'fixtures@evalbuff.local',
  GIT_COMMITTER_NAME: 'Evalbuff Fixtures',
  GIT_COMMITTER_EMAIL: 'fixtures@evalbuff.local',
  GIT_AUTHOR_DATE: '2026-04-08T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-04-08T00:00:00Z',
}

const CODEBUFF_FIXTURE_AGENTS_MD = `# Codebuff

Codebuff is an advanced coding agent with a composable agent framework. It also includes:
- freebuff, the free coding agent

## Goal

Make an efficient learning agent that can do anything.

## Key Technologies

- TypeScript monorepo (Bun workspaces)
- Bun runtime + package manager
- Next.js (web app + API routes)
- Multiple LLM providers (Anthropic/OpenAI/Gemini/etc.)

## Repo Map

- \`cli/\` — TUI client (OpenTUI + React) and local UX
- \`sdk/\` — JS/TS SDK used by the CLI and external users
- \`web/\` — Next.js app + API routes (the "web API")
- \`packages/agent-runtime/\` — agent runtime + tool handling (server-side)
- \`common/\` — shared types, tools, schemas, utilities
- \`agents/\` — main agents shipped with codebuff
- \`.agents/\` — local agent templates (prompt + programmatic agents)
- \`freebuff/\` — a free coding agent built from configuring the codebuff CLI

## Conventions

- Prefer reading the implementation directly before making changes.
- Never force-push \`main\` unless explicitly requested.
- Run interactive git commands in tmux (anything that opens an editor or prompts).
`

export type BenchmarkRepoId = 'mock-simple' | 'codebuff' | 'manifold'

export interface FixtureMetadata {
  id: BenchmarkRepoId
  fixtureVersion: number
  description: string
  repoPath: string
  sourceRepoUrl: string | null
  sourceCommitSha: string | null
  headSha: string
  notes: string[]
}

export interface SetupBenchmarkReposOptions {
  rootDir?: string
  repoIds?: BenchmarkRepoId[]
  force?: boolean
  log?: (message: string) => void
}

interface BenchmarkRepoDefinition {
  id: BenchmarkRepoId
  dirName: string
  description: string
  fixtureVersion: number
  sourceRepoUrl: string | null
  sourceCommitSha: string | null
  setup: (repoDir: string) => FixtureMetadata
}

const MOCK_SIMPLE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'evalbuff-mock-simple',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        test: 'bun test',
        typecheck: 'tsc --noEmit',
      },
    },
    null,
    2,
  ) + '\n',
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
  ) + '\n',
  'README.md': `# Mock Simple Repo

Small deterministic TypeScript repo for evalbuff E2E coverage.
`,
  'src/index.ts': `import { add, fibonacci } from './math'
import { slugify } from './strings'
import { Stack } from './stack'

console.log(add(2, 3))
console.log(fibonacci(8))
console.log(slugify('Evalbuff Fixtures'))

const stack = new Stack<number>()
stack.push(1)
stack.push(2)
console.log(stack.peek())
`,
  'src/math.ts': `export function add(a: number, b: number): number {
  return a + b
}

export function fibonacci(n: number): number {
  if (n <= 0) return 0
  if (n === 1) return 1

  let a = 0
  let b = 1
  for (let i = 2; i <= n; i += 1) {
    ;[a, b] = [b, a + b]
  }
  return b
}
`,
  'src/math.test.ts': `import { expect, test } from 'bun:test'

import { add, fibonacci } from './math'

test('math helpers', () => {
  expect(add(2, 3)).toBe(5)
  expect(fibonacci(8)).toBe(21)
})
`,
  'src/strings.ts': `export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
`,
  'src/strings.test.ts': `import { expect, test } from 'bun:test'

import { slugify } from './strings'

test('slugify', () => {
  expect(slugify('Evalbuff Fixtures')).toBe('evalbuff-fixtures')
})
`,
  'src/stack.ts': `export class Stack<T> {
  private items: T[] = []

  push(item: T): void {
    this.items.push(item)
  }

  peek(): T | undefined {
    return this.items[this.items.length - 1]
  }
}
`,
  'src/stack.test.ts': `import { expect, test } from 'bun:test'

import { Stack } from './stack'

test('stack push and peek', () => {
  const stack = new Stack<number>()
  stack.push(1)
  stack.push(2)
  expect(stack.peek()).toBe(2)
})
`,
}

const BENCHMARK_REPO_DEFINITIONS: readonly BenchmarkRepoDefinition[] = [
  {
    id: 'mock-simple',
    dirName: 'mock-simple',
    description: 'Generated deterministic TypeScript repo for fast local E2E runs.',
    fixtureVersion: FIXTURE_LAYOUT_VERSION,
    sourceRepoUrl: null,
    sourceCommitSha: null,
    setup: (repoDir) => createMockSimpleFixture(repoDir),
  },
  {
    id: 'codebuff',
    dirName: 'codebuff',
    description:
      'Pinned checkout of CodebuffAI/codebuff main with fixture cleanup for evalbuff E2E runs.',
    fixtureVersion: FIXTURE_LAYOUT_VERSION,
    sourceRepoUrl: 'https://github.com/CodebuffAI/codebuff.git',
    sourceCommitSha: 'f95f9a58ebcfcfecc8c6ffcfbe6d606ec1278e54',
    setup: (repoDir) =>
      createPinnedRemoteFixture(repoDir, {
        id: 'codebuff',
        description:
          'Pinned checkout of CodebuffAI/codebuff main with fixture cleanup for evalbuff E2E runs.',
        repoUrl: 'https://github.com/CodebuffAI/codebuff.git',
        commitSha: 'f95f9a58ebcfcfecc8c6ffcfbe6d606ec1278e54',
        postCheckout: patchCodebuffFixture,
      }),
  },
  {
    id: 'manifold',
    dirName: 'manifold',
    description:
      'Pinned checkout of manifoldmarkets/manifold main with docs/ renamed to external-docs/.',
    fixtureVersion: FIXTURE_LAYOUT_VERSION,
    sourceRepoUrl: 'https://github.com/manifoldmarkets/manifold.git',
    sourceCommitSha: '89c1b733190ff717ff7f7d7fb6206b09c61aebd1',
    setup: (repoDir) =>
      createPinnedRemoteFixture(repoDir, {
        id: 'manifold',
        description:
          'Pinned checkout of manifoldmarkets/manifold main with docs/ renamed to external-docs/.',
        repoUrl: 'https://github.com/manifoldmarkets/manifold.git',
        commitSha: '89c1b733190ff717ff7f7d7fb6206b09c61aebd1',
        postCheckout: renameDocsDirForManifoldFixture,
      }),
  },
] as const

export const BENCHMARK_REPO_IDS = BENCHMARK_REPO_DEFINITIONS.map((repo) => repo.id)

export function setupBenchmarkRepos(
  options: SetupBenchmarkReposOptions = {},
): FixtureMetadata[] {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_TEST_REPOS_ROOT)
  const repoIds = options.repoIds ?? [...BENCHMARK_REPO_IDS]
  const force = options.force ?? false
  const log = options.log ?? (() => {})

  fs.mkdirSync(rootDir, { recursive: true })

  const selectedDefinitions = repoIds.map((repoId) => {
    const definition = BENCHMARK_REPO_DEFINITIONS.find((repo) => repo.id === repoId)
    if (!definition) {
      throw new Error(`Unknown benchmark repo id: ${repoId}`)
    }
    return definition
  })

  const results = selectedDefinitions.map((definition) => {
    const repoDir = path.join(rootDir, definition.dirName)
    const existingMetadata = readFixtureMetadata(repoDir)

    if (fs.existsSync(repoDir)) {
      if (!force && existingMetadata && fixtureMatchesDefinition(existingMetadata, definition)) {
        const currentHeadSha = gitOutput(repoDir, ['rev-parse', 'HEAD'])
        const gitStatus = gitOutput(repoDir, ['status', '--porcelain'])
        if (currentHeadSha === existingMetadata.headSha && gitStatus === '') {
          log(`Skipping ${definition.id}; fixture already matches ${currentHeadSha}.`)
          return existingMetadata
        }
      }

      if (!force) {
        throw new Error(
          `Fixture directory already exists and does not match the expected state: ${repoDir}. Re-run with --force to rebuild it.`,
        )
      }

      fs.rmSync(repoDir, { recursive: true, force: true })
    }

    log(`Setting up ${definition.id} in ${repoDir}`)
    const metadata = definition.setup(repoDir)
    writeFixtureMetadata(repoDir, metadata)
    return metadata
  })

  const manifestPath = path.join(rootDir, FIXTURE_MANIFEST_FILENAME)
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        layoutVersion: FIXTURE_LAYOUT_VERSION,
        generatedAt: new Date().toISOString(),
        repos: results,
      },
      null,
      2,
    ) + '\n',
  )

  return results
}

export function renameDocsDirForManifoldFixture(repoDir: string): void {
  const docsDir = path.join(repoDir, 'docs')
  const externalDocsDir = path.join(repoDir, 'external-docs')

  if (!fs.existsSync(docsDir)) {
    throw new Error(`Expected docs/ to exist before manifold patch in ${repoDir}`)
  }
  if (fs.existsSync(externalDocsDir)) {
    throw new Error(`Refusing to overwrite existing external-docs/ in ${repoDir}`)
  }

  fs.renameSync(docsDir, externalDocsDir)
  gitOutput(repoDir, ['add', '-A'])
  gitOutput(repoDir, ['commit', '-m', 'evalbuff: move upstream docs to external-docs'], {
    env: FIXTURE_COMMIT_ENV,
  })
}

export function patchCodebuffFixture(repoDir: string): void {
  const docsDir = path.join(repoDir, 'docs')
  if (fs.existsSync(docsDir)) {
    fs.rmSync(docsDir, { recursive: true, force: true })
  }

  fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), CODEBUFF_FIXTURE_AGENTS_MD)
  gitOutput(repoDir, ['add', '-A'])
  gitOutput(
    repoDir,
    ['commit', '-m', 'evalbuff: remove bundled docs and simplify AGENTS'],
    {
      env: FIXTURE_COMMIT_ENV,
    },
  )
}

function createMockSimpleFixture(repoDir: string): FixtureMetadata {
  initializeRepo(repoDir)

  for (const [filePath, content] of Object.entries(MOCK_SIMPLE_FILES)) {
    writeFile(repoDir, filePath, content)
  }

  gitOutput(repoDir, ['add', '-A'])
  gitOutput(repoDir, ['commit', '-m', 'evalbuff fixture: create mock simple repo'], {
    env: FIXTURE_COMMIT_ENV,
  })

  return {
    id: 'mock-simple',
    fixtureVersion: FIXTURE_LAYOUT_VERSION,
    description: 'Generated deterministic TypeScript repo for fast local E2E runs.',
    repoPath: repoDir,
    sourceRepoUrl: null,
    sourceCommitSha: null,
    headSha: gitOutput(repoDir, ['rev-parse', 'HEAD']),
    notes: ['Generated locally by evalbuff.'],
  }
}

function createPinnedRemoteFixture(
  repoDir: string,
  options: {
    id: Exclude<BenchmarkRepoId, 'mock-simple'>
    description: string
    repoUrl: string
    commitSha: string
    postCheckout?: (repoDir: string) => void
  },
): FixtureMetadata {
  initializeRepo(repoDir)
  gitOutput(repoDir, ['remote', 'add', 'origin', options.repoUrl])
  gitOutput(repoDir, ['fetch', '--depth', '1', 'origin', options.commitSha])
  gitOutput(repoDir, ['checkout', '--detach', 'FETCH_HEAD'])

  const notes = [`Pinned to upstream commit ${options.commitSha}.`]
  if (options.postCheckout) {
    options.postCheckout(repoDir)
  }
  if (options.id === 'codebuff') {
    notes.push('Local fixture commit removes docs/ and rewrites AGENTS.md.')
  }
  if (options.id === 'manifold') {
    notes.push('Local fixture commit renames docs/ to external-docs/.')
  }

  return {
    id: options.id,
    fixtureVersion: FIXTURE_LAYOUT_VERSION,
    description: options.description,
    repoPath: repoDir,
    sourceRepoUrl: options.repoUrl,
    sourceCommitSha: options.commitSha,
    headSha: gitOutput(repoDir, ['rev-parse', 'HEAD']),
    notes,
  }
}

function initializeRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true })
  gitOutput(repoDir, ['init', '--initial-branch=main'])
  gitOutput(repoDir, ['config', 'user.name', FIXTURE_COMMIT_ENV.GIT_AUTHOR_NAME])
  gitOutput(repoDir, ['config', 'user.email', FIXTURE_COMMIT_ENV.GIT_AUTHOR_EMAIL])
}

function fixtureMatchesDefinition(
  metadata: FixtureMetadata,
  definition: BenchmarkRepoDefinition,
): boolean {
  return (
    metadata.id === definition.id &&
    metadata.fixtureVersion === definition.fixtureVersion &&
    metadata.sourceRepoUrl === definition.sourceRepoUrl &&
    metadata.sourceCommitSha === definition.sourceCommitSha
  )
}

function readFixtureMetadata(repoDir: string): FixtureMetadata | null {
  const metadataPath = getFixtureMetadataPath(repoDir)
  if (!fs.existsSync(metadataPath)) {
    return null
  }
  return JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as FixtureMetadata
}

function writeFixtureMetadata(repoDir: string, metadata: FixtureMetadata): void {
  const metadataPath = getFixtureMetadataPath(repoDir)
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n')
}

function getFixtureMetadataPath(repoDir: string): string {
  return path.join(
    path.dirname(repoDir),
    `.${path.basename(repoDir)}.${FIXTURE_METADATA_FILENAME}`,
  )
}

function writeFile(repoDir: string, filePath: string, content: string): void {
  const absolutePath = path.join(repoDir, filePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content)
}

function gitOutput(
  repoDir: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
    env: options?.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
