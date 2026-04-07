import { describe, it, expect } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist')

describe('build smoke test', () => {
  it('dist/cli.js --help runs under Node ESM without import errors', () => {
    // This catches the exact bug where tsc emits extensionless relative imports
    // that Node ESM cannot resolve (ERR_MODULE_NOT_FOUND).
    const output = execSync('node dist/cli.js --help', {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(output).toContain('--repo')
  })

  it('all relative imports in dist/ include .js extensions', () => {
    const jsFiles = readdirSync(DIST, { recursive: true, withFileTypes: false })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.js'))

    const badImports: string[] = []
    for (const rel of jsFiles) {
      const content = readFileSync(join(DIST, rel), 'utf8')
      // Match: from './foo' or from '../bar' without .js extension
      const matches = content.matchAll(/from\s+['"](\.\.[^'"]+|\.\/[^'"]+)['"]/g)
      for (const m of matches) {
        if (!m[1].endsWith('.js')) {
          badImports.push(`${rel}: ${m[0]}`)
        }
      }
    }
    expect(badImports).toEqual([])
  })
})
