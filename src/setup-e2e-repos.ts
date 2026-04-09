#!/usr/bin/env bun
/**
 * Usage:
 *   bun run src/setup-e2e-repos.ts [--root /path/to/test-repos]
 *                                  [--repo mock-simple --repo codebuff --repo manifold]
 *                                  [--force]
 */
import path from 'path'

import {
  BENCHMARK_REPO_IDS,
  DEFAULT_TEST_REPOS_ROOT,
  FIXTURE_MANIFEST_FILENAME,
  type BenchmarkRepoId,
  setupBenchmarkRepos,
} from './e2e-repos'

interface SetupE2EReposCliOptions {
  rootDir: string
  repoIds?: BenchmarkRepoId[]
  force: boolean
}

function parseArgs(argv: string[]): SetupE2EReposCliOptions {
  const options: SetupE2EReposCliOptions = {
    rootDir: DEFAULT_TEST_REPOS_ROOT,
    force: false,
  }

  const repoIds: BenchmarkRepoId[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('Missing value for --root')
      }
      options.rootDir = path.resolve(value)
      index += 1
      continue
    }

    if (arg === '--repo') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('Missing value for --repo')
      }
      if (!BENCHMARK_REPO_IDS.includes(value as BenchmarkRepoId)) {
        throw new Error(
          `Unknown repo id "${value}". Expected one of: ${BENCHMARK_REPO_IDS.join(', ')}`,
        )
      }
      repoIds.push(value as BenchmarkRepoId)
      index += 1
      continue
    }

    if (arg === '--force') {
      options.force = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (repoIds.length > 0) {
    options.repoIds = repoIds
  }

  return options
}

function printHelp(): void {
  console.log(`Usage: bun run src/setup-e2e-repos.ts [options]

Options:
  --root <path>             Directory where benchmark repos will be created
  --repo <id>               Repo to set up; may be repeated
  --force                   Rebuild existing fixtures in place
  -h, --help                Show this help message

Repo ids:
  ${BENCHMARK_REPO_IDS.join(', ')}`)
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  const options = parseArgs(args)

  if (options.rootDir !== DEFAULT_TEST_REPOS_ROOT) {
    console.log(`Using custom root: ${options.rootDir}`)
  }
  if (options.repoIds) {
    console.log(`Selected repos: ${options.repoIds.join(', ')}`)
  }
  if (options.force) {
    console.log('Force rebuild enabled.')
  }

  const results = setupBenchmarkRepos({
    ...options,
    log: (message) => console.log(message),
  })

  console.log(`Wrote manifest: ${path.join(options.rootDir, FIXTURE_MANIFEST_FILENAME)}`)
  for (const result of results) {
    console.log(`${result.id}: ${result.repoPath} @ ${result.headSha}`)
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : `Unexpected error: ${String(error)}`,
    )
    process.exit(1)
  }
}
