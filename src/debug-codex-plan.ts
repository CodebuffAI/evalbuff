import { planFeatures } from './carve-features'

function getArg(args: string[], name: string, defaultValue?: string): string {
  const idx = args.indexOf(`--${name}`)
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
  if (defaultValue !== undefined) return defaultValue
  throw new Error(`Missing required argument: --${name}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const repoPath = getArg(args, 'repo')
  const timeoutMs = Number.parseInt(getArg(args, 'timeout-ms', '60000'), 10)
  const startedAt = Date.now()

  const timeout = setTimeout(() => {
    console.error(`Codex planning timed out after ${timeoutMs}ms for ${repoPath}`)
    process.exit(2)
  }, timeoutMs)

  try {
    const plan = await planFeatures(repoPath)
    clearTimeout(timeout)
    console.log(JSON.stringify({
      ok: true,
      repoPath,
      durationMs: Date.now() - startedAt,
      candidateCount: plan.candidates.length,
      candidateIds: plan.candidates.map((candidate) => candidate.id),
    }, null, 2))
  } catch (error) {
    clearTimeout(timeout)
    const message = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({
      ok: false,
      repoPath,
      durationMs: Date.now() - startedAt,
      error: message,
    }, null, 2))
    process.exit(1)
  }
}

if (import.meta.main) {
  main()
}
