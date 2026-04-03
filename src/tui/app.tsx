/**
 * Evalbuff TUI Dashboard — live-updating view of an evalbuff run.
 *
 * Layout:
 *  ┌─────────────────────────────────────────────────────┐
 *  │  EVALBUFF   repo-name          Phase    elapsed     │
 *  ├───────────────────┬─────────────────────────────────┤
 *  │  Features         │  Activity Log                   │
 *  │  ● feat-1   7.5   │  [ts] message...                │
 *  │  ◐ feat-2   ...   │  [ts] message...                │
 *  │  ○ feat-3   ---   │                                 │
 *  ├───────────────────┴─────────────────────────────────┤
 *  │  R0: 6.2 → R1: 7.1 → R2: --    $4.23   5 features │
 *  └─────────────────────────────────────────────────────┘
 */
import { useState, useEffect, useRef } from 'react'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { events, type TimestampedEvent, type Phase, type FeatureStatus } from './events'

// --- State types ---

interface FeatureState {
  id: string
  status: FeatureStatus
  scores: Record<number, number> // round → score
  cost: number
  detail: string
}

interface RunState {
  repoPath: string
  phase: Phase
  round: number
  loop: number
  phaseDetail: string
  features: Map<string, FeatureState>
  featureOrder: string[]
  roundScores: Map<number, number> // round → avg score
  totalCost: number
  scoreProgression: number[]
  logs: Array<{ ts: string; message: string; level: string }>
  startTime: number
  elapsed: string
  done: boolean
  n: number
  loops: number
  codingModel: string
  docsModel: string
}

function initialState(): RunState {
  return {
    repoPath: '',
    phase: 'planning',
    round: 0,
    loop: 0,
    phaseDetail: 'Initializing...',
    features: new Map(),
    featureOrder: [],
    roundScores: new Map(),
    totalCost: 0,
    scoreProgression: [],
    logs: [],
    startTime: Date.now(),
    elapsed: '00:00',
    done: false,
    n: 0,
    loops: 0,
    codingModel: '',
    docsModel: '',
  }
}

// --- Helpers ---

const STATUS_ICONS: Record<FeatureStatus, string> = {
  pending: '○',
  carving: '◔',
  carved: '◑',
  carve_failed: '✗',
  agent_running: '◐',
  judging: '◕',
  scored: '●',
  eval_failed: '✗',
}

const STATUS_COLORS: Record<FeatureStatus, string> = {
  pending: '#6c7086',
  carving: '#fab387',
  carved: '#a6e3a1',
  carve_failed: '#f38ba8',
  agent_running: '#89b4fa',
  judging: '#cba6f7',
  scored: '#a6e3a1',
  eval_failed: '#f38ba8',
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function phaseLabel(phase: Phase, round: number, loop: number): string {
  switch (phase) {
    case 'planning': return 'Planning Features'
    case 'carving': return 'Carving Features'
    case 'evaluating':
      return round === 0 ? 'Baseline Eval (Round 0)' : `Re-eval (Loop ${loop}, Round ${round})`
    case 'docs_refactor': return `Docs Refactor (Loop ${loop})`
    case 'complete': return 'Complete'
  }
}

function phaseProgress(phase: Phase, round: number, loops: number): number {
  // Rough progress: plan(5%) → carve(10%) → baseline(30%) → loops(remaining)
  if (phase === 'planning') return 0.05
  if (phase === 'carving') return 0.10
  if (phase === 'complete') return 1.0
  if (round === 0) return 0.15 + 0.20 * 0.5 // midway through baseline
  // In loops: each loop is (docs_refactor + eval)
  const loopWeight = 0.65 / loops
  const loopProgress = (round - 1) * loopWeight + (phase === 'docs_refactor' ? 0 : loopWeight * 0.5)
  return 0.35 + loopProgress
}

// --- Components ---

function Header({ state }: { state: RunState }) {
  const repoName = state.repoPath.split('/').pop() || state.repoPath
  const pLabel = phaseLabel(state.phase, state.round, state.loop)
  const progress = phaseProgress(state.phase, state.round, state.loops || 3)
  const pct = Math.round(progress * 100)

  return (
    <box flexDirection="column" paddingX={1}>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text>
          <span fg="#89b4fa" attributes={1}>EVALBUFF</span>
          <span fg="#6c7086">{' '}{repoName}</span>
          <span fg="#585b70">{' '}n={state.n} loops={state.loops} {state.codingModel}/{state.docsModel}</span>
        </text>
        <text fg="#a6adc8">{state.elapsed}</text>
      </box>
      <box height={1}>
        <text>
          <span fg="#cba6f7">[{pct}%]</span>
          <span fg="#cdd6f4">{' '}{pLabel}</span>
          <span fg="#6c7086">{state.phaseDetail ? ` - ${state.phaseDetail}` : ''}</span>
        </text>
      </box>
    </box>
  )
}

function FeatureList({ state, selectedRound }: { state: RunState; selectedRound: number }) {
  return (
    <box
      flexDirection="column"
      border={true}
      borderStyle="rounded"
      borderColor="#45475a"
      title=" Features "
      titleAlignment="left"
      paddingX={1}
      flexShrink={0}
      width="35%"
      minWidth={28}
    >
      {/* Column headers */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg="#6c7086">{'  Name'}</text>
        <text fg="#6c7086">
          {state.roundScores.size > 0
            ? Array.from(state.roundScores.keys()).map(r => `R${r}`).join('  ')
            : 'Score'}
        </text>
      </box>

      {state.featureOrder.map((id) => {
        const f = state.features.get(id)
        if (!f) return null
        const icon = STATUS_ICONS[f.status]
        const color = STATUS_COLORS[f.status]
        const name = id.length > 16 ? id.slice(0, 15) + '…' : id

        // Show scores for each round
        const scoreEntries = Object.entries(f.scores).sort(([a], [b]) => Number(a) - Number(b))
        const scoreStr = scoreEntries.length > 0
          ? scoreEntries.map(([, s]) => s >= 0 ? s.toFixed(1) : ' err').join('  ')
          : f.status === 'eval_failed' || f.status === 'carve_failed' ? 'fail' : '  —'

        return (
          <box key={id} flexDirection="row" justifyContent="space-between">
            <text>
              <span fg={color}>{icon} </span>
              <span fg="#cdd6f4">{name}</span>
            </text>
            <text fg={scoreEntries.some(([, s]) => s >= 7) ? '#a6e3a1' : scoreEntries.some(([, s]) => s >= 0) ? '#f9e2af' : '#6c7086'}>
              {scoreStr}
            </text>
          </box>
        )
      })}

      {state.featureOrder.length === 0 && (
        <text fg="#6c7086">Waiting for features...</text>
      )}
    </box>
  )
}

function ActivityLog({ logs }: { logs: RunState['logs'] }) {
  return (
    <box
      flexDirection="column"
      border={true}
      borderStyle="rounded"
      borderColor="#45475a"
      title=" Activity "
      titleAlignment="left"
      flexGrow={1}
    >
      <scrollbox
        scrollY={true}
        stickyScroll={true}
        stickyStart="bottom"
        flexGrow={1}
      >
        <box flexDirection="column" paddingX={1}>
          {logs.map((log, i) => {
            const time = log.ts.slice(11, 19)
            const levelColor = log.level === 'error' ? '#f38ba8' : log.level === 'warn' ? '#fab387' : '#6c7086'
            return (
              <text key={i}>
                <span fg={levelColor}>{time}</span>
                <span fg="#cdd6f4">{' '}{log.message}</span>
              </text>
            )
          })}
          {logs.length === 0 && (
            <text fg="#6c7086">Waiting for events...</text>
          )}
        </box>
      </scrollbox>
    </box>
  )
}

// --- Main App ---

export function App() {
  const [state, setState] = useState<RunState>(initialState)
  const [selectedRound, setSelectedRound] = useState(0)
  const { width, height } = useTerminalDimensions()

  // Timer for elapsed display
  useEffect(() => {
    const timer = setInterval(() => {
      setState(prev => ({
        ...prev,
        elapsed: formatElapsed(Date.now() - prev.startTime),
      }))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // Subscribe to events
  useEffect(() => {
    const handler = (stamped: TimestampedEvent) => {
      const { event, ts } = stamped

      setState(prev => {
        const next = { ...prev }
        // Clone mutable structures
        next.features = new Map(prev.features)
        next.roundScores = new Map(prev.roundScores)
        next.logs = [...prev.logs]
        next.scoreProgression = [...prev.scoreProgression]
        next.featureOrder = [...prev.featureOrder]

        switch (event.type) {
          case 'run_start':
            next.repoPath = event.repoPath
            next.n = event.n
            next.loops = event.loops
            next.codingModel = event.codingModel
            next.docsModel = event.docsModel
            next.startTime = Date.now()
            next.logs.push({ ts, message: `Run started — ${event.repoPath}`, level: 'info' })
            break

          case 'phase_change':
            next.phase = event.phase
            if (event.round !== undefined) next.round = event.round
            if (event.loop !== undefined) next.loop = event.loop
            next.phaseDetail = event.detail || ''
            next.logs.push({ ts, message: `Phase: ${phaseLabel(event.phase, event.round ?? next.round, event.loop ?? next.loop)}${event.detail ? ` — ${event.detail}` : ''}`, level: 'info' })
            break

          case 'feature_planned':
            next.logs.push({ ts, message: `${event.totalCandidates} candidates found, ${event.selectedIds.length} selected`, level: 'info' })
            for (const id of event.selectedIds) {
              if (!next.features.has(id)) {
                next.features.set(id, { id, status: 'pending', scores: {}, cost: 0, detail: '' })
                next.featureOrder.push(id)
              }
            }
            break

          case 'feature_status': {
            const f = next.features.get(event.featureId) || { id: event.featureId, status: 'pending' as FeatureStatus, scores: {}, cost: 0, detail: '' }
            f.status = event.status
            if (event.score !== undefined) f.scores[next.round] = event.score
            if (event.cost !== undefined) f.cost += event.cost
            if (event.detail !== undefined) f.detail = event.detail
            next.features.set(event.featureId, { ...f, scores: { ...f.scores } })

            if (!next.featureOrder.includes(event.featureId)) {
              next.featureOrder.push(event.featureId)
            }

            // Log meaningful status changes
            const statusMsg: Record<string, string> = {
              carving: `Carving ${event.featureId}...`,
              carved: `Carved ${event.featureId}`,
              carve_failed: `Carve failed: ${event.featureId} — ${event.detail || ''}`,
              agent_running: `Agent running on ${event.featureId}`,
              judging: `Judging ${event.featureId}...`,
              scored: `${event.featureId}: ${event.score?.toFixed(1)}/10`,
              eval_failed: `Eval failed: ${event.featureId} — ${event.detail || ''}`,
            }
            if (statusMsg[event.status]) {
              const level = event.status.includes('fail') ? 'error' : 'info'
              next.logs.push({ ts, message: statusMsg[event.status], level })
            }
            break
          }

          case 'round_complete':
            next.roundScores.set(event.round, event.avgScore)
            next.totalCost = event.totalCost
            next.scoreProgression.push(event.avgScore)
            next.logs.push({ ts, message: `Round ${event.round} complete — avg ${event.avgScore.toFixed(1)}/10, cost $${event.totalCost.toFixed(2)}`, level: 'info' })
            // Reset feature statuses for next round
            for (const [id, f] of next.features) {
              if (f.status === 'scored' || f.status === 'eval_failed') {
                next.features.set(id, { ...f, status: 'pending' })
              }
            }
            break

          case 'docs_refactor':
            if (event.action === 'start') {
              next.logs.push({ ts, message: `Docs refactor loop ${event.loop} — ${event.suggestionCount || 0} suggestions`, level: 'info' })
            } else {
              next.logs.push({ ts, message: `Docs refactor loop ${event.loop} complete`, level: 'info' })
            }
            break

          case 'run_complete':
            next.done = true
            next.phase = 'complete'
            next.phaseDetail = ''
            next.totalCost = event.totalCost
            next.scoreProgression = event.scoreProgression
            next.logs.push({ ts, message: `Run complete! Scores: ${event.scoreProgression.map(s => s.toFixed(1)).join(' → ')} — $${event.totalCost.toFixed(2)}`, level: 'info' })
            break

          case 'log':
            next.logs.push({ ts, message: event.message, level: event.level })
            break
        }

        // Cap log size
        if (next.logs.length > 500) {
          next.logs = next.logs.slice(-400)
        }

        return next
      })
    }

    // Replay any events that fired before mount
    events.replay(handler)
    events.on('event', handler)
    return () => { events.off('event', handler) }
  }, [])

  // Keyboard: q to quit
  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      process.exit(0)
    }
  })

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor="#1e1e2e"
    >
      {/* Header */}
      <Header state={state} />

      {/* Main content: features + log */}
      <box flexDirection="row" flexGrow={1} gap={0}>
        <FeatureList state={state} selectedRound={selectedRound} />
        <ActivityLog logs={state.logs} />
      </box>

      {/* Footer */}
      <box flexDirection="row" justifyContent="space-between" paddingX={2} height={1}>
        <text>
          <span fg="#6c7086">{state.done ? 'Run complete. ' : ''}</span>
          <span fg="#6c7086">Scores: </span>
          <span fg="#a6e3a1">{state.scoreProgression.length > 0 ? state.scoreProgression.map((s, i) => `R${i}: ${s.toFixed(1)}`).join(' → ') : '—'}</span>
        </text>
        <text>
          <span fg="#f9e2af">${state.totalCost.toFixed(2)}</span>
          <span fg="#6c7086">{'  '}{state.featureOrder.length} features  </span>
          <span fg="#585b70">{state.done ? 'q=exit' : 'q=quit'}</span>
        </text>
      </box>
    </box>
  )
}
