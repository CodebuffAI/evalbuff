/**
 * TUI entry point — renders the evalbuff dashboard.
 *
 * Modes:
 *   bun run tui                              Demo mode (simulated run)
 *   bun run tui -- --demo                    Demo mode (explicit)
 *   bun run tui -- --log-dir /tmp/evalbuff-run-...   Replay/watch a past or live run
 *   bun run tui -- --repo /path/to/repo      Start a new run with TUI
 */
import fs from 'fs'
import path from 'path'
import { createCliRenderer, type CliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { App } from './app'
import { events, type TimestampedEvent } from './events'

let renderer: CliRenderer | null = null

function cleanup() {
  if (renderer) {
    try { renderer.destroy() } catch {}
    renderer = null
  }
}

async function startTui() {
  renderer = await createCliRenderer({
    screenMode: 'alternate-screen',
    useMouse: false,
    exitOnCtrlC: true,
  })

  process.on('exit', cleanup)
  process.on('SIGINT', () => { cleanup(); process.exit(0) })
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('uncaughtException', (err) => {
    cleanup()
    console.error('Uncaught exception:', err)
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    cleanup()
    console.error('Unhandled rejection:', err)
    process.exit(1)
  })

  createRoot(renderer).render(<App />)
  renderer.start()

  return renderer
}

// --- Replay mode: load events.jsonl from a log directory ---

async function replayLogDir(logDir: string) {
  const eventsPath = path.join(logDir, 'events.jsonl')

  if (!fs.existsSync(eventsPath)) {
    events.log(`No events.jsonl found in ${logDir}`, 'error')
    events.log('This log directory may be from before TUI support was added.', 'info')
    return
  }

  // Replay existing events instantly
  const content = fs.readFileSync(eventsPath, 'utf-8')
  const lines = content.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const stamped: TimestampedEvent = JSON.parse(line)
      events.send(stamped.event)
    } catch {}
  }

  events.log(`Replayed ${lines.length} events from ${logDir}`, 'info')

  // If the run isn't complete, watch for new events (tail -f style)
  const lastEvent = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null
  if (!lastEvent || lastEvent.event.type !== 'run_complete') {
    events.log('Run still in progress — watching for new events...', 'info')
    let offset = content.length

    const watcher = fs.watch(eventsPath, () => {
      const newContent = fs.readFileSync(eventsPath, 'utf-8')
      if (newContent.length > offset) {
        const newLines = newContent.slice(offset).trim().split('\n').filter(Boolean)
        for (const line of newLines) {
          try {
            const stamped: TimestampedEvent = JSON.parse(line)
            events.send(stamped.event)
          } catch {}
        }
        offset = newContent.length
      }
    })

    process.on('exit', () => watcher.close())
  }
}

// --- Find recent log dirs ---

function findRecentLogDirs(): string[] {
  const tmpDir = require('os').tmpdir()
  try {
    return fs.readdirSync(tmpDir)
      .filter(name => name.startsWith('evalbuff-run-'))
      .map(name => path.join(tmpDir, name))
      .filter(p => {
        try { return fs.statSync(p).isDirectory() } catch { return false }
      })
      .sort()
      .reverse()
      .slice(0, 10)
  } catch {
    return []
  }
}

// --- Demo mode ---

async function runDemo() {
  const featureIds = ['auth-login', 'search-api', 'file-upload', 'tag-system', 'csv-export']

  events.send({
    type: 'run_start',
    repoPath: '/Users/demo/my-project',
    n: 5,
    loops: 2,
    parallelism: 3,
    codingModel: 'sonnet',
    docsModel: 'opus',
    logDir: '/tmp/evalbuff-demo',
  })

  await sleep(800)
  events.send({ type: 'phase_change', phase: 'planning', detail: 'Analyzing codebase...' })
  await sleep(2000)

  events.send({ type: 'feature_planned', totalCandidates: 18, selectedIds: featureIds })
  events.log('Selected 5 features from 18 candidates')

  await sleep(500)
  events.send({ type: 'phase_change', phase: 'carving', detail: `Carving ${featureIds.length} features...` })

  for (const id of featureIds) {
    events.send({ type: 'feature_status', featureId: id, status: 'carving' })
    await sleep(600 + Math.random() * 800)
    events.send({ type: 'feature_status', featureId: id, status: 'carved', detail: '3 file operations' })
  }

  await sleep(300)
  events.send({ type: 'phase_change', phase: 'evaluating', round: 0, detail: 'Baseline' })

  const baselineScores: Record<string, number> = {}
  for (const id of featureIds) {
    events.send({ type: 'feature_status', featureId: id, status: 'agent_running' })
    await sleep(1500 + Math.random() * 1500)
    events.send({ type: 'feature_status', featureId: id, status: 'judging' })
    await sleep(800 + Math.random() * 600)
    const score = 4 + Math.random() * 4
    baselineScores[id] = Math.round(score * 10) / 10
    events.send({ type: 'feature_status', featureId: id, status: 'scored', score: baselineScores[id], cost: 0.15 + Math.random() * 0.3 })
  }

  const avgBaseline = Object.values(baselineScores).reduce((a, b) => a + b, 0) / featureIds.length
  events.send({ type: 'round_complete', round: 0, avgScore: avgBaseline, totalCost: 2.34, scores: baselineScores })

  // Loop 1
  await sleep(500)
  events.send({ type: 'phase_change', phase: 'docs_refactor', loop: 1 })
  events.send({ type: 'docs_refactor', action: 'start', loop: 1, suggestionCount: 12 })
  await sleep(2500)
  events.send({ type: 'docs_refactor', action: 'complete', loop: 1 })

  await sleep(300)
  events.send({ type: 'phase_change', phase: 'evaluating', round: 1, loop: 1, detail: 'Re-eval with updated docs' })

  const loop1Scores: Record<string, number> = {}
  for (const id of featureIds) {
    events.send({ type: 'feature_status', featureId: id, status: 'agent_running' })
    await sleep(1200 + Math.random() * 1200)
    events.send({ type: 'feature_status', featureId: id, status: 'judging' })
    await sleep(600 + Math.random() * 500)
    const improvement = 0.5 + Math.random() * 1.5
    const score = Math.min(10, baselineScores[id] + improvement)
    loop1Scores[id] = Math.round(score * 10) / 10
    events.send({ type: 'feature_status', featureId: id, status: 'scored', score: loop1Scores[id], cost: 0.15 + Math.random() * 0.3 })
  }

  const avgLoop1 = Object.values(loop1Scores).reduce((a, b) => a + b, 0) / featureIds.length
  events.send({ type: 'round_complete', round: 1, avgScore: avgLoop1, totalCost: 4.68, scores: loop1Scores })

  // Loop 2
  await sleep(500)
  events.send({ type: 'phase_change', phase: 'docs_refactor', loop: 2 })
  events.send({ type: 'docs_refactor', action: 'start', loop: 2, suggestionCount: 8 })
  await sleep(2000)
  events.send({ type: 'docs_refactor', action: 'complete', loop: 2 })

  await sleep(300)
  events.send({ type: 'phase_change', phase: 'evaluating', round: 2, loop: 2, detail: 'Re-eval with updated docs' })

  const loop2Scores: Record<string, number> = {}
  for (const id of featureIds) {
    events.send({ type: 'feature_status', featureId: id, status: 'agent_running' })
    await sleep(1000 + Math.random() * 1000)
    events.send({ type: 'feature_status', featureId: id, status: 'judging' })
    await sleep(500 + Math.random() * 400)
    const improvement = 0.3 + Math.random() * 1.0
    const score = Math.min(10, loop1Scores[id] + improvement)
    loop2Scores[id] = Math.round(score * 10) / 10
    events.send({ type: 'feature_status', featureId: id, status: 'scored', score: loop2Scores[id], cost: 0.15 + Math.random() * 0.3 })
  }

  const avgLoop2 = Object.values(loop2Scores).reduce((a, b) => a + b, 0) / featureIds.length
  events.send({ type: 'round_complete', round: 2, avgScore: avgLoop2, totalCost: 7.02, scores: loop2Scores })

  await sleep(500)
  events.send({
    type: 'run_complete',
    scoreProgression: [avgBaseline, avgLoop1, avgLoop2],
    totalCost: 7.02,
    duration: '3m 45s',
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2)
  const isDemo = args.includes('--demo')
  const hasRepo = args.includes('--repo')

  const logDirIdx = args.indexOf('--log-dir')
  const logDir = logDirIdx >= 0 && logDirIdx + 1 < args.length ? args[logDirIdx + 1] : null

  // If no specific mode, check for recent runs to replay
  if (!isDemo && !hasRepo && !logDir) {
    const recent = findRecentLogDirs()
    const withEvents = recent.filter(d => fs.existsSync(path.join(d, 'events.jsonl')))

    if (withEvents.length > 0) {
      // Auto-replay the most recent run
      await startTui()
      events.log(`Found ${withEvents.length} recent run(s). Showing latest:`, 'info')
      events.log(withEvents[0], 'info')
      await replayLogDir(withEvents[0])
      return
    }

    // No recent runs — fall through to demo
    await startTui()
    runDemo().catch(err => events.log(`Demo error: ${err}`, 'error'))
    return
  }

  await startTui()

  if (logDir) {
    await replayLogDir(logDir)
  } else if (isDemo || !hasRepo) {
    runDemo().catch(err => events.log(`Demo error: ${err}`, 'error'))
  } else {
    const { runEvalbuff } = await import('../run-evalbuff')

    const getArg = (name: string, defaultValue?: string): string => {
      const idx = args.indexOf(`--${name}`)
      if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
      if (defaultValue !== undefined) return defaultValue
      throw new Error(`Missing required argument: --${name}`)
    }
    const hasArg = (name: string): boolean => args.includes(`--${name}`)

    const repoPath = getArg('repo')
    const n = parseInt(getArg('n', '5'))
    const parallelism = parseInt(getArg('parallelism', '10'))
    const loops = parseInt(getArg('loops', '3'))
    const initCommand = hasArg('init-command') ? getArg('init-command') : undefined
    const codingModel = getArg('coding-model', 'sonnet')
    const docsModel = getArg('docs-model', 'opus')

    runEvalbuff({ repoPath, n, parallelism, loops, initCommand, codingModel, docsModel }).catch(err => {
      events.log(`Run failed: ${err}`, 'error')
    })
  }
}

main().catch(err => {
  cleanup()
  console.error('TUI failed to start:', err)
  process.exit(1)
})
