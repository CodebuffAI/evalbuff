#!/usr/bin/env node
/**
 * Post-build: add .js extensions to relative imports in dist/
 * so that Node ESM can resolve them.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dist = process.argv[2] || 'dist'

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) files.push(...await walk(full))
    else if (e.name.endsWith('.js')) files.push(full)
  }
  return files
}

// Match: from './foo' or from "../bar" — relative imports missing .js
const importRe = /(from\s+['"])(\.\.?\/[^'"]+)(?<!\.js)(['"])/g

const files = await walk(dist)
let fixed = 0
for (const file of files) {
  const src = await readFile(file, 'utf8')
  const out = src.replace(importRe, '$1$2.js$3')
  if (out !== src) {
    await writeFile(file, out)
    fixed++
  }
}
console.log(`Fixed ESM imports in ${fixed} files`)
