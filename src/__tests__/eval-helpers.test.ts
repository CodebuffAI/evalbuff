import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, it } from 'bun:test'

import {
  captureGitDiff,
  copyDocsIntoRepo,
  extractDocsRead,
  getGroundTruthDiff,
} from '../eval-helpers'

import type { CarvedFeature } from '../carve-features'
import type { AgentStep } from '../runners/runner'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('copyDocsIntoRepo', () => {
  it('mirrors the current docs subset and leaves a clean git status', () => {
    const sourceRepo = createRepo({
      'docs/guide.md': '# Guide\nsource version\n',
      'AGENTS.md': '# Agents\nfollow this\n',
    })
    const targetRepo = createRepo({
      'docs/guide.md': '# Guide\nold target version\n',
      'docs/stale.md': '# Stale\nremove me\n',
      'CLAUDE.md': '# Claude\nremove me too\n',
    })

    copyDocsIntoRepo(sourceRepo, targetRepo)

    expect(readFile(targetRepo, 'docs/guide.md')).toContain('source version')
    expect(readFile(targetRepo, 'AGENTS.md')).toContain('follow this')
    expect(fs.existsSync(path.join(targetRepo, 'docs/stale.md'))).toBe(false)
    expect(fs.existsSync(path.join(targetRepo, 'CLAUDE.md'))).toBe(false)
    expect(git(targetRepo, 'log -1 --pretty=%s')).toBe('evalbuff: pre-load docs')
    expect(git(targetRepo, 'status --short')).toBe('')
  })
})

describe('extractDocsRead', () => {
  it('normalizes doc paths discovered inside shell commands and file reads', () => {
    const steps: AgentStep[] = [
      {
        type: 'tool_call',
        toolCallId: '1',
        toolName: 'shell',
        input: { command: "cat docs/guide.md AGENTS.md && sed -n '1,5p' ./docs/extra.md" },
      },
      {
        type: 'tool_call',
        toolCallId: '2',
        toolName: 'read_file',
        input: { path: '/tmp/example/docs/reference.md' },
      },
    ]

    expect(extractDocsRead(steps)).toEqual([
      'AGENTS.md',
      'docs/extra.md',
      'docs/guide.md',
      'docs/reference.md',
    ])
  })
})

describe('getGroundTruthDiff', () => {
  it('returns flipped rebuild diff from computeGroundTruthDiff when operations are available', () => {
    const feature: CarvedFeature = {
      id: 'feature-x',
      prompt: 'Restore feature x',
      description: 'Restores a feature that touched shared files',
      complexity: 'medium',
      originalFiles: {
        'src/feature.ts': 'export const feature = true\n',
        'src/index.ts': "console.log('with feature')\n",
      },
      operations: [
        { path: 'src/feature.ts', action: 'delete' },
        { path: 'src/index.ts', action: 'modify', newContent: "console.log('without feature')\n" },
      ],
      diff: [
        'diff --git a/src/feature.ts b/src/feature.ts',
        'deleted file mode 100644',
        'diff --git a/src/index.ts b/src/index.ts',
        "@@ -1 +1 @@",
        "-console.log('with feature')",
        "+console.log('without feature')",
      ].join('\n'),
    }

    const diff = getGroundTruthDiff(feature)

    // Should be the rebuild (flipped) diff, not the raw carve diff
    expect(diff).not.toBe(feature.diff)
    expect(diff).toContain('+export const feature = true')
    expect(diff).toContain("+console.log('with feature')")
    expect(diff).toContain("-console.log('without feature')")
  })

  it('falls back to raw carve diff when operations produce empty rebuild', () => {
    const feature: CarvedFeature = {
      id: 'feature-y',
      prompt: 'Restore feature y',
      description: 'Feature with no originalFiles',
      complexity: 'small',
      originalFiles: {},
      operations: [
        { path: 'src/thing.ts', action: 'delete' },
      ],
      diff: 'diff --git a/src/thing.ts b/src/thing.ts\ndeleted file mode 100644',
    }

    const diff = getGroundTruthDiff(feature)
    expect(diff).toBe(feature.diff)
  })
})

describe('captureGitDiff', () => {
  it('captures committed changes plus untracked files from the original base SHA', () => {
    const repo = createRepo({
      'src/app.ts': "export const version = '1.0.0'\n",
    })
    const baseSha = git(repo, 'rev-parse HEAD')

    writeFile(repo, 'src/app.ts', "export const version = '2.0.0'\n")
    git(repo, 'add -A')
    git(repo, 'commit -m "update app"')
    writeFile(repo, 'src/new-file.ts', 'export const created = true\n')

    const diff = captureGitDiff(repo, { baseRef: baseSha })

    expect(diff).toContain('src/app.ts')
    expect(diff).toContain('src/new-file.ts')
  })

  it('respects pathspec limits so unrelated files stay out of the diff', () => {
    const repo = createRepo({
      'docs/guide.md': '# Guide\nold\n',
      'src/app.ts': "export const value = 1\n",
    })
    const baseSha = git(repo, 'rev-parse HEAD')

    writeFile(repo, 'docs/guide.md', '# Guide\nnew\n')
    writeFile(repo, 'src/app.ts', "export const value = 2\n")

    const diff = captureGitDiff(repo, {
      baseRef: baseSha,
      pathspecs: ['docs/guide.md'],
    })

    expect(diff).toContain('docs/guide.md')
    expect(diff).not.toContain('src/app.ts')
  })
})

function createRepo(files: Record<string, string>): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-test-repo-'))
  tempDirs.push(repoDir)

  git(repoDir, 'init')
  git(repoDir, 'config user.name "Test User"')
  git(repoDir, 'config user.email "test@evalbuff.test"')

  for (const [filePath, content] of Object.entries(files)) {
    writeFile(repoDir, filePath, content)
  }

  git(repoDir, 'add -A')
  git(repoDir, 'commit -m "Initial commit"')
  return repoDir
}

function writeFile(repoDir: string, filePath: string, content: string): void {
  const absolutePath = path.join(repoDir, filePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content)
}

function readFile(repoDir: string, filePath: string): string {
  return fs.readFileSync(path.join(repoDir, filePath), 'utf-8')
}

function git(repoDir: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}
