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

  return renderer
}

function renderApp(r: CliRenderer, startView: 'dashboard' | 'run_picker', onLoadRun: (dir: string) => void) {
  createRoot(r).render(<App startView={startView} onLoadRun={onLoadRun} />)
  r.start()
}

// --- Replay mode: load events.jsonl from a log directory ---

/** Synthesize events from filesystem data (summary.json, round dirs) to fill gaps.
 *  Marks what it synthesized in seenEventTypes so it won't duplicate on re-call. */
function augmentFromFilesystem(logDir: string, seenEventTypes: Set<string>) {
  const hasRunStart = seenEventTypes.has('run_start')
  const hasFeatures = seenEventTypes.has('feature_planned')
  const hasScores = seenEventTypes.has('round_complete')
  const hasComplete = seenEventTypes.has('run_complete')

  const summaryPath = path.join(logDir, 'summary.json')
  const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) : null

  if (!hasRunStart) {
    seenEventTypes.add('run_start')
    events.send({
      type: 'run_start',
      repoPath: summary?.repoPath || logDir,
      n: summary?.featuresCarved || 0,
      codingModel: '?',
      docsModel: '?',
      logDir,
    })
  }

  // Try features.json for feature IDs (written before any round completes)
  if (!hasFeatures) {
    const featuresPath = path.join(logDir, 'features.json')
    if (fs.existsSync(featuresPath)) {
      try {
        const features = JSON.parse(fs.readFileSync(featuresPath, 'utf-8')) as Array<{ id: string }>
        if (features.length > 0) {
          seenEventTypes.add('feature_planned')
          events.send({ type: 'feature_planned', totalCandidates: features.length, selectedIds: features.map(f => f.id) })
          for (const f of features) {
            events.send({ type: 'feature_status', featureId: f.id, status: 'carved' })
          }
        }
      } catch {}
    }
  }

  // Always try to synthesize feature/score data from summary if missing
  if (summary && (!hasFeatures || !hasScores)) {
    const allIds = new Set<string>()
    for (const round of summary.rounds || []) {
      for (const id of Object.keys(round.scores || {})) allIds.add(id)
    }

    if (!hasFeatures && allIds.size > 0) {
      seenEventTypes.add('feature_planned')
      events.send({ type: 'feature_planned', totalCandidates: allIds.size, selectedIds: [...allIds] })
    }

    if (!hasScores) {
      seenEventTypes.add('round_complete')
      for (const round of summary.rounds || []) {
        events.send({ type: 'phase_change', phase: 'evaluating', round: round.round, loop: round.round })
        for (const [id, score] of Object.entries(round.scores || {})) {
          events.send({ type: 'feature_status', featureId: id, status: 'scored', score: score as number })
        }
        events.send({ type: 'round_complete', round: round.round, avgScore: round.avgScore, totalCost: round.totalCost, scores: round.scores })
      }
    }

    if (!hasComplete && summary.scoreProgression) {
      seenEventTypes.add('run_complete')
      events.send({ type: 'run_complete', scoreProgression: summary.scoreProgression, totalCost: summary.totalCost, duration: '' })
    }
  }

  // Even without summary.json, try round directories
  if (!summary && !hasScores) {
    for (let r = 0; r < 20; r++) {
      const roundSummaryPath = path.join(logDir, `round-${r}`, 'summary.json')
      if (!fs.existsSync(roundSummaryPath)) break
      try {
        const rs = JSON.parse(fs.readFileSync(roundSummaryPath, 'utf-8'))
        events.send({ type: 'phase_change', phase: 'evaluating', round: r, loop: r })
        // Get feature IDs from the round directory
        const roundDir = path.join(logDir, `round-${r}`)
        const featureIds = fs.readdirSync(roundDir, { withFileTypes: true })
          .filter(e => e.isDirectory()).map(e => e.name)
        if (r === 0 && !hasFeatures) {
          events.send({ type: 'feature_planned', totalCandidates: featureIds.length, selectedIds: featureIds })
        }
        for (const id of featureIds) {
          const scorePath = path.join(roundDir, id, 'score.txt')
          const score = fs.existsSync(scorePath) ? parseFloat(fs.readFileSync(scorePath, 'utf-8')) : -1
          events.send({ type: 'feature_status', featureId: id, status: 'scored', score })
        }
        events.send({ type: 'round_complete', round: r, avgScore: rs.avgScore || 0, totalCost: rs.totalCost || 0, scores: Object.fromEntries(rs.tasks?.map((t: any) => [t.featureId, t.score]) || []) })
      } catch {}
    }
  }
}

async function replayLogDir(logDir: string) {
  const eventsPath = path.join(logDir, 'events.jsonl')
  const seenEventTypes = new Set<string>()

  // Step 1: Replay events.jsonl if it exists
  if (fs.existsSync(eventsPath)) {
    const content = fs.readFileSync(eventsPath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const stamped: TimestampedEvent = JSON.parse(line)
        seenEventTypes.add(stamped.event.type)
        events.send(stamped.event)
      } catch {}
    }
    events.log(`Replayed ${lines.length} events from log`, 'info')
  }

  // Step 2: Fill gaps from filesystem data
  augmentFromFilesystem(logDir, seenEventTypes)

  // Step 3: If still in progress, watch for new events
  const isComplete = seenEventTypes.has('run_complete') || fs.existsSync(path.join(logDir, 'summary.json'))
  if (!isComplete && fs.existsSync(eventsPath)) {
    events.log('Run in progress — watching for new events...', 'info')
    const content = fs.readFileSync(eventsPath, 'utf-8')
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

    // Also periodically re-scan filesystem for new data files (features.json, round dirs)
    const fsPoller = setInterval(() => {
      augmentFromFilesystem(logDir, seenEventTypes)
    }, 3000)

    process.on('exit', () => { watcher.close(); clearInterval(fsPoller) })
  }
}

// --- Find recent log dirs ---

function findRecentLogDirs(): string[] {
  const dirs: string[] = []

  // New default: scan .evalbuff/ in current working directory
  const evalbuffDir = path.join(process.cwd(), '.evalbuff')
  try {
    for (const name of fs.readdirSync(evalbuffDir)) {
      if (name.startsWith('run-') || name.startsWith('perfect-')) {
        const full = path.join(evalbuffDir, name)
        try { if (fs.statSync(full).isDirectory()) dirs.push(full) } catch {}
      }
    }
  } catch {}

  return [...new Set(dirs)].sort().reverse().slice(0, 10)
}

// --- Demo mode ---

async function runDemo() {
  const featureIds = ['auth-login', 'search-api', 'file-upload', 'tag-system', 'csv-export']

  events.send({
    type: 'run_start',
    repoPath: '/Users/demo/my-project',
    n: 20,
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
  events.send({ type: 'phase_change', phase: 'docs_writer', loop: 1 })
  events.send({ type: 'docs_writer', action: 'start', loop: 1, suggestionCount: 12 })
  await sleep(2500)
  events.send({ type: 'docs_writer', action: 'complete', loop: 1 })

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

  await sleep(500)
  events.send({
    type: 'run_complete',
    scoreProgression: [avgBaseline, avgLoop1],
    totalCost: 4.68,
    duration: '2m 10s',
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

  /** Load a run from a log directory — clears old state and replays */
  function loadRun(dir: string) {
    // Clear the event buffer so old run data doesn't persist
    events.clearBuffer()
    replayLogDir(dir)
  }

  const r = await startTui()

  if (isDemo) {
    renderApp(r, 'dashboard', loadRun)
    runDemo().catch(err => events.log(`Demo error: ${err}`, 'error'))
  } else if (logDir) {
    renderApp(r, 'dashboard', loadRun)
    await replayLogDir(logDir)
  } else if (hasRepo) {
    renderApp(r, 'dashboard', loadRun)
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
    const initCommand = hasArg('init-command') ? getArg('init-command') : undefined
    const codingModel = getArg('coding-model', 'sonnet')
    const docsModel = getArg('docs-model', 'opus')
    const cachedFeatures = hasArg('cached-features') ? getArg('cached-features') : undefined
    const outputDir = hasArg('output-dir') ? getArg('output-dir') : undefined

    runEvalbuff({ repoPath, n, initCommand, codingModel, docsModel, cachedFeatures, outputDir }).catch(err => {
      events.log(`Run failed: ${err}`, 'error')
    })
  } else {
    // No specific run — start with run picker
    renderApp(r, 'run_picker', loadRun)
  }
}

main().catch(err => {
  cleanup()
  console.error('TUI failed to start:', err)
  process.exit(1)
})
