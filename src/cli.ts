#!/usr/bin/env node
/**
 * Evalbuff CLI entry point.
 *
 * Usage:
 *   evalbuff --repo /path/to/repo [--n 20] [--parallelism 1] [--loops 1]
 *            [--init-command "npm install"] [--coding-model sonnet] [--docs-model opus]
 *            [--cached-features /path/to/features.json]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { runEvalbuff } from './run-evalbuff'

const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-V')) {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  console.log(version)
  process.exit(0)
}

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: evalbuff --repo /path/to/repo [options]

Options:
  --repo <path>              Path to the target repository (required)
  --n <number>               Number of features to evaluate (default: 20)
  --parallelism <number>     Max concurrent carve/setup jobs (default: 1)
  --loops <number>           Number of optimization loops (default: 1)
  --init-command <command>   Command to run before each agent run
  --coding-model <model>     Model for coding agent (default: sonnet)
  --docs-model <model>       Model for docs agent (default: opus)
  --cached-features <path>   Path to pre-computed features JSON
  -V, --version              Show version number
  -h, --help                 Show this help message`)
  process.exit(0)
}

const getArg = (name: string, defaultValue?: string): string => {
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
  if (defaultValue !== undefined) return defaultValue
  throw new Error(`Missing required argument: --${name}`)
}
const hasArg = (name: string): boolean => args.includes(`--${name}`)

const repoPath = getArg('repo')
const n = parseInt(getArg('n', '20'))
const parallelism = parseInt(getArg('parallelism', '1'))
const loops = parseInt(getArg('loops', '1'))
const initCommand = hasArg('init-command') ? getArg('init-command') : undefined
const codingModel = getArg('coding-model', 'sonnet')
const docsModel = getArg('docs-model', 'opus')
const cachedFeatures = hasArg('cached-features') ? getArg('cached-features') : undefined

runEvalbuff({
  repoPath,
  n,
  parallelism,
  loops,
  initCommand,
  codingModel,
  docsModel,
  cachedFeatures,
}).catch((error) => {
  console.error('Evalbuff run failed:', error)
  process.exit(1)
})
