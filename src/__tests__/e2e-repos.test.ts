import { execFileSync, execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import { afterEach, describe, expect, it } from 'bun:test'

import {
  FIXTURE_MANIFEST_FILENAME,
  patchCodebuffFixture,
  renameDocsDirForManifoldFixture,
  setupBenchmarkRepos,
} from '../e2e-repos'

const tempDirs: string[] = []
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('setupBenchmarkRepos', () => {
  it('creates only the selected mock fixture and writes a manifest', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-e2e-repos-'))
    tempDirs.push(rootDir)

    const results = setupBenchmarkRepos({
      rootDir,
      repoIds: ['mock-simple'],
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe('mock-simple')
    expect(fs.existsSync(path.join(rootDir, 'mock-simple', '.git'))).toBe(true)
    expect(fs.existsSync(path.join(rootDir, 'codebuff'))).toBe(false)
    expect(fs.existsSync(path.join(rootDir, 'manifold'))).toBe(false)

    const manifest = JSON.parse(
      fs.readFileSync(path.join(rootDir, FIXTURE_MANIFEST_FILENAME), 'utf-8'),
    ) as { repos: Array<{ id: string; headSha: string }> }

    expect(manifest.repos).toHaveLength(1)
    expect(manifest.repos[0]?.id).toBe('mock-simple')
    expect(git(path.join(rootDir, 'mock-simple'), 'rev-parse HEAD')).toBe(results[0]?.headSha)
    expect(git(path.join(rootDir, 'mock-simple'), 'status --short')).toBe('')
  })

  it('rebuilds a matching fixture when force is enabled', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-e2e-repos-force-'))
    tempDirs.push(rootDir)

    const firstRun = setupBenchmarkRepos({
      rootDir,
      repoIds: ['mock-simple'],
    })
    const firstHead = firstRun[0]?.headSha

    const secondRun = setupBenchmarkRepos({
      rootDir,
      repoIds: ['mock-simple'],
      force: true,
    })

    expect(secondRun).toHaveLength(1)
    expect(secondRun[0]?.id).toBe('mock-simple')
    expect(secondRun[0]?.headSha).toBe(firstHead)
    expect(git(path.join(rootDir, 'mock-simple'), 'status --short')).toBe('')
  })
})

describe('renameDocsDirForManifoldFixture', () => {
  it('moves docs to external-docs and leaves a clean commit', () => {
    const repoDir = createRepo({
      'docs/guide.md': '# Guide\nfixture docs\n',
      'src/index.ts': "export const version = '1.0.0'\n",
    })

    const baseSha = git(repoDir, 'rev-parse HEAD')

    renameDocsDirForManifoldFixture(repoDir)

    expect(fs.existsSync(path.join(repoDir, 'docs'))).toBe(false)
    expect(fs.existsSync(path.join(repoDir, 'external-docs', 'guide.md'))).toBe(true)
    expect(
      fs.readFileSync(path.join(repoDir, 'external-docs', 'guide.md'), 'utf-8'),
    ).toContain('fixture docs')
    expect(git(repoDir, 'log -1 --pretty=%s')).toBe(
      'evalbuff: move upstream docs to external-docs',
    )
    expect(git(repoDir, 'status --short')).toBe('')
    expect(git(repoDir, 'rev-parse HEAD')).not.toBe(baseSha)
  })
})

describe('patchCodebuffFixture', () => {
  it('removes docs and rewrites AGENTS without docs references', () => {
    const repoDir = createRepo({
      'docs/guide.md': '# Guide\nfixture docs\n',
      'AGENTS.md': '# Upstream\nSee docs/guide.md\n',
      'src/index.ts': "export const version = '1.0.0'\n",
    })

    const baseSha = git(repoDir, 'rev-parse HEAD')

    patchCodebuffFixture(repoDir)

    expect(fs.existsSync(path.join(repoDir, 'docs'))).toBe(false)
    const agentsMd = fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('# Codebuff')
    expect(agentsMd.toLowerCase()).not.toContain('docs')
    expect(git(repoDir, 'log -1 --pretty=%s')).toBe(
      'evalbuff: remove bundled docs and simplify AGENTS',
    )
    expect(git(repoDir, 'status --short')).toBe('')
    expect(git(repoDir, 'rev-parse HEAD')).not.toBe(baseSha)
  })
})

describe('setup-e2e-repos CLI', () => {
  it('honors --root and --repo for a mock-only setup', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-e2e-cli-'))
    tempDirs.push(rootDir)

    execFileSync(
      process.execPath,
      ['run', 'src/setup-e2e-repos.ts', '--root', rootDir, '--repo', 'mock-simple'],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    )

    expect(fs.existsSync(path.join(rootDir, 'mock-simple', '.git'))).toBe(true)
    expect(fs.existsSync(path.join(rootDir, 'codebuff'))).toBe(false)
    expect(fs.existsSync(path.join(rootDir, FIXTURE_MANIFEST_FILENAME))).toBe(true)
  })
})

function createRepo(files: Record<string, string>): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-repo-fixture-'))
  tempDirs.push(repoDir)

  git(repoDir, 'init')
  git(repoDir, 'config user.name "Test User"')
  git(repoDir, 'config user.email "test@evalbuff.test"')

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoDir, filePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content)
  }

  git(repoDir, 'add -A')
  git(repoDir, 'commit -m "Initial commit"')
  return repoDir
}

function git(repoDir: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}
