#!/usr/bin/env node
/**
 * Evalbuff CLI entry point.
 *
 * Usage:
 *   evalbuff --repo /path/to/repo [--n 20] [--parallelism 10] [--loops 3]
 *            [--init-command "npm install"] [--coding-model sonnet] [--docs-model opus]
 *            [--cached-features /path/to/features.json]
 */
import { runEvalbuff } from './run-evalbuff'

const args = process.argv.slice(2)

const getArg = (name: string, defaultValue?: string): string => {
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
  if (defaultValue !== undefined) return defaultValue
  throw new Error(`Missing required argument: --${name}`)
}
const hasArg = (name: string): boolean => args.includes(`--${name}`)

const repoPath = getArg('repo')
const n = parseInt(getArg('n', '20'))
const parallelism = parseInt(getArg('parallelism', '10'))
const loops = parseInt(getArg('loops', '3'))
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
