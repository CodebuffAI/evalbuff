import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import type { CarvedFeature, FileOperation } from './carve-features'
import type { AgentStep } from './runners/runner'

export function selectRandom<T>(items: T[], count: number): T[] {
  const shuffled = [...items].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

export function applyCarveOperations(repoDir: string, operations: FileOperation[]): void {
  for (const op of operations) {
    const fullPath = path.join(repoDir, op.path)
    if (op.action === 'delete') {
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath)
      }
    } else if (op.action === 'modify' && op.newContent !== undefined) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, op.newContent)
    }
  }
}

const DOC_PATH_PATTERN = /(?:^|\/)(?:docs\/|AGENTS\.md|CLAUDE\.md)/

export function extractDocsRead(steps: AgentStep[]): string[] {
  const seen = new Set<string>()
  for (const step of steps) {
    if (step.type !== 'tool_call') continue
    const filePath: string | undefined =
      step.input?.file_path || step.input?.path || step.input?.command
    if (typeof filePath !== 'string') continue

    if ((step.toolName === 'Read' || step.toolName === 'read_file') && DOC_PATH_PATTERN.test(filePath)) {
      const match = filePath.match(/((?:docs\/\S+|AGENTS\.md|CLAUDE\.md))/)
      if (match) seen.add(match[1])
    }
    if (step.toolName === 'shell' && DOC_PATH_PATTERN.test(filePath)) {
      const matches = filePath.match(/((?:docs\/\S+|AGENTS\.md|CLAUDE\.md))/g)
      if (matches) for (const m of matches) seen.add(m)
    }
  }
  return [...seen].sort()
}

export function computeGroundTruthDiff(feature: CarvedFeature): string {
  const diffs: string[] = []
  for (const op of feature.operations) {
    if (op.action === 'delete' && feature.originalFiles[op.path]) {
      const lines = feature.originalFiles[op.path].split('\n')
      diffs.push(
        `--- /dev/null\n+++ b/${op.path}\n@@ -0,0 +1,${lines.length} @@\n` +
          lines.map((l) => `+${l}`).join('\n'),
      )
    } else if (op.action === 'modify' && feature.originalFiles[op.path]) {
      const origLines = feature.originalFiles[op.path].split('\n')
      const carvedLines = (op.newContent || '').split('\n')
      diffs.push(
        `--- a/${op.path}\n+++ b/${op.path}\n@@ -1,${carvedLines.length} +1,${origLines.length} @@\n` +
          carvedLines.map((l) => `-${l}`).join('\n') + '\n' +
          origLines.map((l) => `+${l}`).join('\n'),
      )
    }
  }
  return diffs.join('\n\n')
}

export function copyDocsIntoRepo(sourceRepoPath: string, targetRepoPath: string): void {
  const sourceDocsDir = path.join(sourceRepoPath, 'docs')
  const sourceAgentsMd = path.join(sourceRepoPath, 'AGENTS.md')
  const sourceClaudeMd = path.join(sourceRepoPath, 'CLAUDE.md')
  const targetDocsDir = path.join(targetRepoPath, 'docs')

  let copied = false
  if (fs.existsSync(sourceDocsDir)) {
    fs.cpSync(sourceDocsDir, targetDocsDir, { recursive: true })
    copied = true
  }
  if (fs.existsSync(sourceAgentsMd)) {
    fs.cpSync(sourceAgentsMd, path.join(targetRepoPath, 'AGENTS.md'))
    copied = true
  }
  if (fs.existsSync(sourceClaudeMd)) {
    fs.cpSync(sourceClaudeMd, path.join(targetRepoPath, 'CLAUDE.md'))
    copied = true
  }

  if (copied) {
    try {
      execSync(
        'git add docs/ AGENTS.md CLAUDE.md 2>/dev/null; git add -u docs/ AGENTS.md CLAUDE.md 2>/dev/null',
        { cwd: targetRepoPath, stdio: 'ignore' },
      )
      execSync('git commit -m "evalbuff: pre-load docs" --allow-empty', {
        cwd: targetRepoPath,
        stdio: 'ignore',
      })
    } catch {
      // fine
    }
  }
}

export function getDocsSnapshot(repoPath: string): Record<string, string> {
  const docs: Record<string, string> = {}
  const docsDir = path.join(repoPath, 'docs')

  if (fs.existsSync(docsDir)) {
    function readDir(dir: string, prefix: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          readDir(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        } else if (entry.name.endsWith('.md')) {
          docs[`docs/${prefix}${entry.name}`] = fs.readFileSync(path.join(dir, entry.name), 'utf-8')
        }
      }
    }
    readDir(docsDir, '')
  }

  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const p = path.join(repoPath, file)
    if (fs.existsSync(p)) {
      docs[file] = fs.readFileSync(p, 'utf-8')
    }
  }

  return docs
}

export function computeDocsDiffText(before: Record<string, string>, after: Record<string, string>): string {
  const lines: string[] = []
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])

  for (const key of [...allKeys].sort()) {
    if (!(key in before)) {
      lines.push(`\n=== NEW FILE: ${key} ===`)
      lines.push(after[key])
    } else if (!(key in after)) {
      lines.push(`\n=== DELETED FILE: ${key} ===`)
      lines.push(`(was ${before[key].split('\n').length} lines)`)
    } else if (before[key] !== after[key]) {
      lines.push(`\n=== MODIFIED FILE: ${key} ===`)
      lines.push(`--- before`)
      lines.push(`+++ after`)
      const oldLines = before[key].split('\n')
      const newLines = after[key].split('\n')
      const maxLen = Math.max(oldLines.length, newLines.length)
      for (let i = 0; i < maxLen; i++) {
        if (i >= oldLines.length) {
          lines.push(`+${newLines[i]}`)
        } else if (i >= newLines.length) {
          lines.push(`-${oldLines[i]}`)
        } else if (oldLines[i] !== newLines[i]) {
          lines.push(`-${oldLines[i]}`)
          lines.push(`+${newLines[i]}`)
        }
      }
    }
  }

  return lines.join('\n')
}
