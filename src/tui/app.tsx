/**
 * Evalbuff TUI Dashboard — drill-down navigation into run data.
 *
 * Views:
 *   Dashboard  → overview with features + activity log
 *   Feature    → per-feature detail across all rounds
 *   Round      → per-round detail with all features, docs diff
 *   Judging    → full judge output for one feature in one round
 *   Summary    → score progression, cost, report
 *
 * Navigation: arrow keys to move, Enter to drill in, Esc to go back, q to quit
 */
import { useState, useEffect, useCallback } from 'react'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { events, type TimestampedEvent, type Phase, type FeatureStatus } from './events'
import { loadLogDir, reloadLogDir, type LogDirData, type JudgingResult } from './data'

// ============================================================
// State types
// ============================================================

interface FeatureState {
  id: string
  status: FeatureStatus
  scores: Record<number, number>
  cost: number
  detail: string
}

interface RunState {
  repoPath: string
  logDir: string
  phase: Phase
  round: number
  loop: number
  phaseDetail: string
  features: Map<string, FeatureState>
  featureOrder: string[]
  roundScores: Map<number, number>
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

type View =
  | { type: 'run_picker' }
  | { type: 'dashboard' }
  | { type: 'feature'; featureId: string }
  | { type: 'round'; round: number }
  | { type: 'judging'; featureId: string; round: number }
  | { type: 'summary' }
  | { type: 'diff'; title: string; diff: string }

export interface RunInfo {
  dir: string
  name: string
  timestamp: string
  repoPath: string
  status: 'complete' | 'in_progress' | 'empty'
  featuresCount: number
  roundsCount: number
  scoreProgression: number[]
  totalCost: number
}

function initialState(): RunState {
  return {
    repoPath: '', logDir: '', phase: 'planning', round: 0, loop: 0,
    phaseDetail: 'Initializing...', features: new Map(), featureOrder: [],
    roundScores: new Map(), totalCost: 0, scoreProgression: [],
    logs: [], startTime: Date.now(), elapsed: '00:00', done: false,
    n: 0, loops: 0, codingModel: '', docsModel: '',
  }
}

// ============================================================
// Helpers
// ============================================================

const STATUS_ICONS: Record<FeatureStatus, string> = {
  pending: '○', carving: '◔', carved: '◑', carve_failed: '✗',
  agent_running: '◐', judging: '◕', scored: '●', eval_failed: '✗',
}
const STATUS_COLORS: Record<FeatureStatus, string> = {
  pending: '#6c7086', carving: '#fab387', carved: '#a6e3a1', carve_failed: '#f38ba8',
  agent_running: '#89b4fa', judging: '#cba6f7', scored: '#a6e3a1', eval_failed: '#f38ba8',
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
  if (phase === 'planning') return 0.05
  if (phase === 'carving') return 0.10
  if (phase === 'complete') return 1.0
  if (round === 0) return 0.25
  const loopWeight = 0.65 / (loops || 1)
  const loopProgress = (round - 1) * loopWeight + (phase === 'docs_refactor' ? 0 : loopWeight * 0.5)
  return 0.35 + loopProgress
}

function scoreColor(score: number): string {
  if (score < 0) return '#f38ba8'
  if (score >= 8) return '#a6e3a1'
  if (score >= 6) return '#f9e2af'
  if (score >= 4) return '#fab387'
  return '#f38ba8'
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** Invert a unified diff: swap +/- so removed code appears as additions (the feature to rebuild) */
function invertDiff(diff: string): string {
  return diff.split('\n').map(line => {
    if (line.startsWith('---')) return line.replace(/^--- a\//, '--- b/')
    if (line.startsWith('+++')) return line.replace(/^\+\+\+ b\//, '+++ a/')
    if (line.startsWith('+')) return '-' + line.slice(1)
    if (line.startsWith('-')) return '+' + line.slice(1)
    // Swap hunk header counts: @@ -old,old +new,new @@ → @@ -new,new +old,old @@
    const hunkMatch = line.match(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)/)
    if (hunkMatch) return `@@ -${hunkMatch[2]} +${hunkMatch[1]} @@${hunkMatch[3]}`
    return line
  }).join('\n')
}

/** Extract the diff chunk for a single file from a unified diff */
function extractFileDiff(fullDiff: string, filePath: string): string | null {
  const lines = fullDiff.split('\n')
  let inFile = false
  const result: string[] = []

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (inFile) break // We already captured our file, stop at next
      // Check if this diff block is for our file
      if (line.includes(`a/${filePath}`) || line.includes(`b/${filePath}`)) {
        inFile = true
      }
    }
    if (inFile) result.push(line)
  }

  return result.length > 0 ? result.join('\n') : null
}

// ============================================================
// Dashboard View (top-level)
// ============================================================

function DashboardView({ state, cursor, onSelect }: {
  state: RunState
  cursor: number
  onSelect: (id: string) => void
}) {
  const pLabel = phaseLabel(state.phase, state.round, state.loop)
  const pct = Math.round(phaseProgress(state.phase, state.round, state.loops || 3) * 100)
  const repoName = state.repoPath.split('/').pop() || state.repoPath

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#1e1e2e">
      {/* Header */}
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

      {/* Main content */}
      <box flexDirection="row" flexGrow={1}>
        {/* Feature list */}
        <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
          title=" Features " titleAlignment="left" paddingX={1} width="35%" minWidth={28}>
          <box flexDirection="row" justifyContent="space-between" height={1}>
            <text fg="#6c7086">{'  Name'}</text>
            <text fg="#6c7086">
              {state.roundScores.size > 0
                ? Array.from(state.roundScores.keys()).map(r => `R${r}`).join('  ')
                : 'Score'}
            </text>
          </box>

          {state.featureOrder.map((id, idx) => {
            const f = state.features.get(id)
            if (!f) return null
            const icon = STATUS_ICONS[f.status]
            const color = STATUS_COLORS[f.status]
            const name = truncate(id, 16)
            const selected = idx === cursor

            const scoreEntries = Object.entries(f.scores).sort(([a], [b]) => Number(a) - Number(b))
            const scoreStr = scoreEntries.length > 0
              ? scoreEntries.map(([, s]) => s >= 0 ? s.toFixed(1) : ' err').join('  ')
              : f.status === 'eval_failed' || f.status === 'carve_failed' ? 'fail' : '  —'

            return (
              <box key={id} flexDirection="row" justifyContent="space-between" height={1}
                backgroundColor={selected ? '#313244' : undefined}>
                <text>
                  <span fg={selected ? '#cdd6f4' : '#585b70'}>{selected ? '>' : ' '}</span>
                  <span fg={color}>{icon} </span>
                  <span fg="#cdd6f4">{name}</span>
                </text>
                <text fg={scoreEntries.some(([, s]) => s >= 7) ? '#a6e3a1' : scoreEntries.some(([, s]) => s >= 0) ? '#f9e2af' : '#6c7086'}>
                  {scoreStr}
                </text>
              </box>
            )
          })}

          {state.featureOrder.length === 0 && <text fg="#6c7086">Waiting for features...</text>}
        </box>

        {/* Activity log */}
        <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
          title=" Activity " titleAlignment="left" flexGrow={1}>
          <scrollbox scrollY={true} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <box flexDirection="column" paddingX={1}>
              {state.logs.map((log, i) => {
                const time = log.ts.slice(11, 19)
                const lc = log.level === 'error' ? '#f38ba8' : log.level === 'warn' ? '#fab387' : '#6c7086'
                return (
                  <text key={i}>
                    <span fg={lc}>{time}</span>
                    <span fg="#cdd6f4">{' '}{log.message}</span>
                  </text>
                )
              })}
              {state.logs.length === 0 && <text fg="#6c7086">Waiting for events...</text>}
            </box>
          </scrollbox>
        </box>
      </box>

      {/* Footer */}
      <box flexDirection="row" justifyContent="space-between" paddingX={2} height={1}>
        <text>
          <span fg="#a6e3a1">{state.scoreProgression.length > 0 ? state.scoreProgression.map((s, i) => `R${i}:${s.toFixed(1)}`).join(' -> ') : '—'}</span>
          <span fg="#6c7086">{' '}${state.totalCost.toFixed(2)}</span>
        </text>
        <text fg="#585b70">j/k=move  Enter=detail  s=summary  r=rounds  p=runs  q=quit</text>
      </box>
    </box>
  )
}

// ============================================================
// Feature Detail View
// ============================================================

function FeatureDetailView({ featureId, state, logData, selectedRound, fileCursor, onViewDiff }: {
  featureId: string
  state: RunState
  logData: LogDirData | null
  selectedRound: number
  fileCursor: number
  onViewDiff: (title: string, diff: string) => void
}) {
  const f = state.features.get(featureId)
  const feature = logData?.features.find(ft => ft.id === featureId)
  const plan = logData?.plan?.candidates.find(c => c.id === featureId)
  const roundData = logData?.rounds[selectedRound]
  const featureRound = roundData?.features.find(rf => rf.featureId === featureId)
  const judging = featureRound?.judging

  // Build file operation list from carve data
  const ops = feature?.operations || []
  const deletedCount = ops.filter(o => o.action === 'delete').length
  const modifiedCount = ops.filter(o => o.action === 'modify').length

  const carveDiff = feature?.diff || ''
  const hasScores = f && Object.keys(f.scores).length > 0

  // Filter diff to selected file (or show full diff if no file selected)
  const selectedFilePath = ops[fileCursor]?.path
  const displayDiff = selectedFilePath && carveDiff
    ? (extractFileDiff(carveDiff, selectedFilePath) || carveDiff)
    : carveDiff

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#1e1e2e">
      {/* Header */}
      <box flexDirection="column" paddingX={1}>
        <box flexDirection="row" justifyContent="space-between" height={1}>
          <text>
            <span fg="#585b70">{'< '}</span>
            <span fg="#89b4fa" attributes={1}>{featureId}</span>
            <span fg="#6c7086">{feature ? ` (${feature.complexity})` : ''}</span>
            <span fg="#585b70">{hasScores ? `  Round ${selectedRound}` : ''}</span>
          </text>
          <text>
            <span fg="#a6e3a1">{deletedCount > 0 ? `+${deletedCount} new` : ''}</span>
            <span fg="#6c7086">{deletedCount > 0 && modifiedCount > 0 ? '  ' : ''}</span>
            <span fg="#f9e2af">{modifiedCount > 0 ? `~${modifiedCount} modified` : ''}</span>
            <span fg="#6c7086">{' '}{ops.length} file{ops.length !== 1 ? 's' : ''}</span>
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1}>
        {/* Left panel: carve info + scores */}
        <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
          title=" Carve Info " paddingX={1} width="35%" minWidth={28}>
          <scrollbox scrollY={true} flexGrow={1}>
            <box flexDirection="column">
              {/* Prompt */}
              <text fg="#6c7086" attributes={1}>Prompt</text>
              <text fg="#cdd6f4" wrapMode="word">{feature?.prompt || plan?.prompt || '(no prompt)'}</text>

              {feature?.description && (
                <box marginTop={1} flexDirection="column">
                  <text fg="#6c7086" attributes={1}>Description</text>
                  <text fg="#a6adc8" wrapMode="word">{feature.description}</text>
                </box>
              )}

              {/* File operations */}
              <box marginTop={1} flexDirection="column">
                <text fg="#6c7086" attributes={1}>Files carved</text>
                {ops.map((op, idx) => {
                  const sel = idx === fileCursor
                  const icon = op.action === 'delete' ? '+' : '~'
                  const color = op.action === 'delete' ? '#a6e3a1' : '#f9e2af'
                  return (
                    <box key={idx} height={1} backgroundColor={sel ? '#313244' : undefined}>
                      <text>
                        <span fg={sel ? '#cdd6f4' : '#585b70'}>{sel ? '>' : ' '}</span>
                        <span fg={color}>{icon} </span>
                        <span fg="#cdd6f4">{op.path}</span>
                      </text>
                    </box>
                  )
                })}
                {ops.length === 0 && <text fg="#585b70">(no file data)</text>}
              </box>

              {/* Relevant files from plan */}
              {plan?.relevantFiles && plan.relevantFiles.length > 0 && (
                <box marginTop={1} flexDirection="column">
                  <text fg="#6c7086" attributes={1}>Relevant files</text>
                  {plan.relevantFiles.map((rf, i) => (
                    <text key={i} fg="#585b70">{' '}{rf}</text>
                  ))}
                </box>
              )}

              {/* Scores */}
              {hasScores && (
                <box marginTop={1} flexDirection="column">
                  <text fg="#6c7086" attributes={1}>Scores</text>
                  {Object.entries(f.scores).sort(([a], [b]) => Number(a) - Number(b)).map(([r, s]) => {
                    const sel = Number(r) === selectedRound
                    return (
                      <box key={r} height={1} backgroundColor={sel ? '#313244' : undefined}>
                        <text>
                          <span fg="#6c7086">R{r}: </span>
                          <span fg={scoreColor(s)}>{s >= 0 ? s.toFixed(1) : 'fail'}</span>
                          <span fg="#6c7086">/10</span>
                        </text>
                      </box>
                    )
                  })}
                </box>
              )}

              {/* Sub-scores */}
              {judging && (
                <box marginTop={1} flexDirection="column">
                  <text fg="#6c7086" attributes={1}>Sub-scores (R{selectedRound})</text>
                  <text><span fg="#6c7086">Completion:   </span><span fg={scoreColor(judging.completionScore)}>{judging.completionScore}/10</span></text>
                  <text><span fg="#6c7086">Code Quality: </span><span fg={scoreColor(judging.codeQualityScore)}>{judging.codeQualityScore}/10</span></text>
                  <text><span fg="#6c7086">E2E Tests:    </span><span fg={scoreColor(judging.e2eScore)}>{judging.e2eScore}/10</span></text>
                </box>
              )}

              {f && (
                <box marginTop={1} flexDirection="column">
                  <text fg="#585b70">Cost: ${f.cost.toFixed(2)}</text>
                </box>
              )}
            </box>
          </scrollbox>
        </box>

        {/* Right panel: judging or carve diff */}
        {judging ? (
          <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
            title={` Judging (R${selectedRound}) `} flexGrow={1}>
            <scrollbox scrollY={true} flexGrow={1}>
              <box flexDirection="column" paddingX={1}>
                <text fg="#6c7086">Analysis:</text>
                <text fg="#cdd6f4" wrapMode="word">{judging.analysis}</text>

                {judging.strengths.length > 0 && (
                  <box flexDirection="column" marginTop={1}>
                    <text fg="#a6e3a1" attributes={1}>Strengths:</text>
                    {judging.strengths.map((s, i) => <text key={i} fg="#a6e3a1">{' + '}{s}</text>)}
                  </box>
                )}

                {judging.weaknesses.length > 0 && (
                  <box flexDirection="column" marginTop={1}>
                    <text fg="#f38ba8" attributes={1}>Weaknesses:</text>
                    {judging.weaknesses.map((w, i) => <text key={i} fg="#f38ba8">{' - '}{w}</text>)}
                  </box>
                )}

                {judging.e2eTestsPerformed.length > 0 && (
                  <box flexDirection="column" marginTop={1}>
                    <text fg="#89b4fa" attributes={1}>E2E Tests:</text>
                    {judging.e2eTestsPerformed.map((t, i) => <text key={i} fg="#89b4fa">{' * '}{t}</text>)}
                  </box>
                )}

                {judging.docSuggestions && judging.docSuggestions.length > 0 && (
                  <box flexDirection="column" marginTop={1}>
                    <text fg="#f9e2af" attributes={1}>Doc Suggestions:</text>
                    {judging.docSuggestions.map((d, i) => <text key={i} fg="#f9e2af" wrapMode="word">{' > '}{d}</text>)}
                  </box>
                )}
              </box>
            </scrollbox>
          </box>
        ) : (
          <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
            title={` ${selectedFilePath || 'Feature Code'} (ground truth) `} flexGrow={1}>
            <scrollbox scrollY={true} flexGrow={1}>
              <box flexDirection="column" paddingX={1}>
                {displayDiff ? invertDiff(displayDiff).split('\n').slice(0, 300).map((line, i) => {
                  const fg = line.startsWith('+') ? '#a6e3a1'
                    : line.startsWith('-') ? '#f38ba8'
                    : line.startsWith('@@') ? '#89b4fa'
                    : line.startsWith('diff') ? '#cba6f7'
                    : '#6c7086'
                  return <text key={i} fg={fg}>{line || ' '}</text>
                }) : <text fg="#6c7086">No carve diff available. Agent hasn't been evaluated yet.</text>}
              </box>
            </scrollbox>
          </box>
        )}
      </box>

      {/* Bottom diff panel (agent diff when scored, filtered to selected file) */}
      {featureRound?.diff && (() => {
        const agentDiff = selectedFilePath
          ? (extractFileDiff(featureRound.diff, selectedFilePath) || featureRound.diff)
          : featureRound.diff
        return (
        <box border={true} borderStyle="rounded" borderColor="#45475a"
          title={` Agent Diff (R${selectedRound})${selectedFilePath ? ` ${selectedFilePath}` : ''} `} height="25%" minHeight={5}>
          <scrollbox scrollY={true} flexGrow={1}>
            <box flexDirection="column" paddingX={1}>
              {agentDiff.split('\n').slice(0, 100).map((line, i) => {
                const fg = line.startsWith('+') ? '#a6e3a1'
                  : line.startsWith('-') ? '#f38ba8'
                  : line.startsWith('@@') ? '#89b4fa'
                  : '#6c7086'
                return <text key={i} fg={fg}>{line || ' '}</text>
              })}
            </box>
          </scrollbox>
        </box>
        )
      })()}

      <box paddingX={2} height={1}>
        <text fg="#585b70">Esc=back  j/k=files  Enter=full diff  Tab=round  q=quit</text>
      </box>
    </box>
  )
}

// ============================================================
// Round Detail View
// ============================================================

function RoundDetailView({ round, state, logData, cursor, onBack }: {
  round: number
  state: RunState
  logData: LogDirData | null
  cursor: number
  onBack: () => void
}) {
  const roundData = logData?.rounds[round]
  const loopData = round > 0 ? logData?.loops[round - 1] : null
  const avgScore = state.roundScores.get(round) ?? roundData?.avgScore ?? 0

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#1e1e2e">
      <box flexDirection="column" paddingX={1}>
        <box flexDirection="row" justifyContent="space-between" height={1}>
          <text>
            <span fg="#585b70">{'< '}</span>
            <span fg="#89b4fa" attributes={1}>Round {round}</span>
            <span fg="#6c7086">{round === 0 ? ' (Baseline)' : ` (Loop ${round})`}</span>
          </text>
          <text>
            <span fg="#6c7086">Avg: </span>
            <span fg={scoreColor(avgScore)}>{avgScore.toFixed(1)}/10</span>
            <span fg="#6c7086">{' '}Cost: ${roundData?.totalCost.toFixed(2) || '?'}</span>
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1}>
        {/* Feature scores */}
        <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
          title=" Feature Scores " paddingX={1} width="40%">
          <scrollbox scrollY={true} flexGrow={1}>
            <box flexDirection="column">
              {roundData?.features.map((rf, idx) => {
                const sel = idx === cursor
                return (
                  <box key={rf.featureId} height={1} backgroundColor={sel ? '#313244' : undefined}>
                    <text>
                      <span fg={sel ? '#cdd6f4' : '#585b70'}>{sel ? '>' : ' '}</span>
                      <span fg={scoreColor(rf.score)}>{rf.score >= 0 ? rf.score.toFixed(1).padStart(4) : 'fail'}</span>
                      <span fg="#6c7086">{' '}</span>
                      <span fg="#cdd6f4">{rf.featureId}</span>
                      <span fg="#585b70">{' $'}{rf.costEstimate.toFixed(2)}</span>
                    </text>
                  </box>
                )
              }) || <text fg="#6c7086">No data for this round.</text>}
            </box>
          </scrollbox>
        </box>

        {/* Right panel: docs diff or judge suggestions */}
        <box flexDirection="column" flexGrow={1}>
          {loopData?.docsDiff && (
            <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
              title={` Docs Changes (Loop ${round}) `} flexGrow={1}>
              <scrollbox scrollY={true} flexGrow={1}>
                <box flexDirection="column" paddingX={1}>
                  {loopData.docsDiff.split('\n').slice(0, 200).map((line, i) => {
                    const fg = line.startsWith('+') ? '#a6e3a1'
                      : line.startsWith('-') ? '#f38ba8'
                      : line.startsWith('@@') ? '#89b4fa'
                      : '#6c7086'
                    return <text key={i} fg={fg}>{line || ' '}</text>
                  })}
                </box>
              </scrollbox>
            </box>
          )}

          {loopData?.judgeSuggestions && (
            <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
              title=" Judge Suggestions " flexGrow={loopData.docsDiff ? 0 : 1} height={loopData.docsDiff ? '40%' : undefined}>
              <scrollbox scrollY={true} flexGrow={1}>
                <box flexDirection="column" paddingX={1}>
                  <text fg="#f9e2af" wrapMode="word">{loopData.judgeSuggestions}</text>
                </box>
              </scrollbox>
            </box>
          )}

          {!loopData && (
            <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
              title=" Info " flexGrow={1} paddingX={1}>
              <text fg="#6c7086">Baseline round — no docs changes applied.</text>
              <text fg="#6c7086" wrapMode="word">
                This is the first evaluation round. Agents are tested against the current docs.
                After this round, judge suggestions will be collected and docs will be updated.
              </text>
            </box>
          )}
        </box>
      </box>

      <box paddingX={2} height={1}>
        <text fg="#585b70">Esc=back  j/k=move  Enter=feature detail  q=quit</text>
      </box>
    </box>
  )
}

// ============================================================
// Summary View
// ============================================================

function SummaryView({ state, logData, onBack }: {
  state: RunState
  logData: LogDirData | null
  onBack: () => void
}) {
  const summary = logData?.summary

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#1e1e2e">
      <box flexDirection="column" paddingX={1}>
        <box height={1}>
          <text>
            <span fg="#585b70">{'< '}</span>
            <span fg="#89b4fa" attributes={1}>Run Summary</span>
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1}>
        {/* Left: score progression + config */}
        <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
          title=" Score Progression " paddingX={1} width="40%">
          {/* Visual bar chart */}
          {state.scoreProgression.map((score, i) => {
            const barLen = Math.min(Math.round(score * 2), 20)
            const bar = '='.repeat(barLen)
            return (
              <box key={i} height={1}>
                <text>
                  <span fg="#6c7086">R{i} </span>
                  <span fg={scoreColor(score)}>{bar} {score.toFixed(1)}</span>
                </text>
              </box>
            )
          })}

          {state.scoreProgression.length >= 2 && (
            <box marginTop={1}>
              <text>
                <span fg="#6c7086">Delta: </span>
                <span fg={state.scoreProgression[state.scoreProgression.length - 1] > state.scoreProgression[0] ? '#a6e3a1' : '#f38ba8'}>
                  {(state.scoreProgression[state.scoreProgression.length - 1] - state.scoreProgression[0]) >= 0 ? '+' : ''}
                  {(state.scoreProgression[state.scoreProgression.length - 1] - state.scoreProgression[0]).toFixed(1)}
                </span>
              </text>
            </box>
          )}

          <box flexDirection="column" marginTop={1}>
            <text fg="#6c7086">--- Config ---</text>
            <text fg="#cdd6f4">Repo: {state.repoPath}</text>
            <text fg="#cdd6f4">Features: {state.featureOrder.length}</text>
            <text fg="#cdd6f4">Loops: {state.loops}</text>
            <text fg="#cdd6f4">Coding: {state.codingModel}</text>
            <text fg="#cdd6f4">Docs: {state.docsModel}</text>
            <text fg="#cdd6f4">Total cost: ${state.totalCost.toFixed(2)}</text>
            {summary && <text fg="#cdd6f4">Duration: {summary.startTime.slice(11, 19)} - {summary.endTime.slice(11, 19)}</text>}
            {state.logDir && <text fg="#585b70" wrapMode="word">Log: {state.logDir}</text>}
          </box>
        </box>

        {/* Right: per-feature comparison table + report */}
        <box flexDirection="column" flexGrow={1}>
          {/* Feature x Round table */}
          <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
            title=" Features x Rounds " paddingX={1} height="40%">
            <scrollbox scrollY={true} flexGrow={1}>
              <box flexDirection="column">
                {/* Header row */}
                <box height={1}>
                  <text>
                    <span fg="#6c7086">{'Feature'.padEnd(20)}</span>
                    {state.scoreProgression.map((_, i) => (
                      <span key={i} fg="#6c7086">{`R${i}`.padStart(6)}</span>
                    ))}
                    <span fg="#6c7086">{'  delta'}</span>
                  </text>
                </box>
                {state.featureOrder.map(id => {
                  const f = state.features.get(id)
                  if (!f) return null
                  const scores = Object.entries(f.scores).sort(([a], [b]) => Number(a) - Number(b))
                  const first = scores[0]?.[1] ?? 0
                  const last = scores[scores.length - 1]?.[1] ?? 0
                  const delta = last - first
                  return (
                    <box key={id} height={1}>
                      <text>
                        <span fg="#cdd6f4">{truncate(id, 20).padEnd(20)}</span>
                        {scores.map(([r, s]) => (
                          <span key={r} fg={scoreColor(s)}>{(s >= 0 ? s.toFixed(1) : 'fail').padStart(6)}</span>
                        ))}
                        <span fg={delta >= 0 ? '#a6e3a1' : '#f38ba8'}>{(delta >= 0 ? '+' + delta.toFixed(1) : delta.toFixed(1)).padStart(7)}</span>
                      </text>
                    </box>
                  )
                })}
              </box>
            </scrollbox>
          </box>

          {/* Report */}
          {logData?.report && (
            <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
              title=" Report " flexGrow={1}>
              <scrollbox scrollY={true} flexGrow={1}>
                <box flexDirection="column" paddingX={1}>
                  {logData.report.split('\n').slice(0, 300).map((line, i) => {
                    const fg = line.startsWith('#') ? '#89b4fa'
                      : line.startsWith('|') ? '#cdd6f4'
                      : line.startsWith('>') ? '#f9e2af'
                      : '#a6adc8'
                    return <text key={i} fg={fg}>{line || ' '}</text>
                  })}
                </box>
              </scrollbox>
            </box>
          )}
        </box>
      </box>

      <box paddingX={2} height={1}>
        <text fg="#585b70">Esc=back  q=quit</text>
      </box>
    </box>
  )
}

// ============================================================
// Run Picker View
// ============================================================

/** Scan for evalbuff run directories across temp locations */
function scanRunDirs(): RunInfo[] {
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const tmpDir = os.tmpdir()
  const dirs: string[] = []

  // Scan both os.tmpdir() and /tmp (they can differ on macOS)
  for (const base of [tmpDir, '/tmp']) {
    try {
      for (const name of fs.readdirSync(base)) {
        if (name.startsWith('evalbuff-run-')) {
          const full = path.join(base, name)
          try {
            if (fs.statSync(full).isDirectory()) dirs.push(full)
          } catch {}
        }
      }
    } catch {}
  }

  // Deduplicate and sort newest first
  const unique = [...new Set(dirs)].sort().reverse()

  return unique.slice(0, 30).map(dir => {
    const name = path.basename(dir)
    // Extract timestamp from dir name: evalbuff-run-2026-04-03T05-31-50
    const tsMatch = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/)
    const timestamp = tsMatch ? tsMatch[1].replace(/-/g, (m: string, i: number) => i > 9 ? ':' : m).replace('T', ' ') : name

    const summaryPath = path.join(dir, 'summary.json')
    const featuresPath = path.join(dir, 'features.json')
    const eventsPath = path.join(dir, 'events.jsonl')

    let repoPath = ''
    let scoreProgression: number[] = []
    let totalCost = 0
    let featuresCount = 0
    let roundsCount = 0
    let status: RunInfo['status'] = 'empty'

    // Try summary.json first (completed runs)
    if (fs.existsSync(summaryPath)) {
      try {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
        repoPath = summary.repoPath || ''
        scoreProgression = summary.scoreProgression || []
        totalCost = summary.totalCost || 0
        featuresCount = summary.featuresCarved || 0
        roundsCount = summary.rounds?.length || 0
        status = 'complete'
      } catch {}
    } else {
      // Try events.jsonl for repo path
      if (fs.existsSync(eventsPath)) {
        try {
          const firstLine = fs.readFileSync(eventsPath, 'utf-8').split('\n')[0]
          const ev = JSON.parse(firstLine)
          if (ev.event?.repoPath) repoPath = ev.event.repoPath
        } catch {}
        status = 'in_progress'
      }
      // Count features
      if (fs.existsSync(featuresPath)) {
        try {
          featuresCount = JSON.parse(fs.readFileSync(featuresPath, 'utf-8')).length
        } catch {}
      }
      // Count rounds
      for (let r = 0; r < 20; r++) {
        if (fs.existsSync(path.join(dir, `round-${r}`))) roundsCount++
        else break
      }
    }

    // Skip empty directories with no data at all
    const hasAnyData = fs.existsSync(eventsPath) || fs.existsSync(summaryPath) || fs.existsSync(featuresPath)
    if (!hasAnyData) status = 'empty'

    return { dir, name, timestamp, repoPath, status, featuresCount, roundsCount, scoreProgression, totalCost }
  }).filter(r => r.status !== 'empty')
}

function RunPickerView({ runs, cursor, onSelect }: {
  runs: RunInfo[]
  cursor: number
  onSelect: (dir: string) => void
}) {

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#1e1e2e">
      <box paddingX={1} height={1}>
        <text>
          <span fg="#89b4fa" attributes={1}>EVALBUFF</span>
          <span fg="#6c7086">{' '}Select a run ({runs.length} found)</span>
        </text>
      </box>

      <box flexDirection="column" border={true} borderStyle="rounded" borderColor="#45475a"
        title=" Past Runs " flexGrow={1}>
        <scrollbox scrollY={true} flexGrow={1}>
          <box flexDirection="column" paddingX={1}>
            {runs.map((run, idx) => {
              const sel = idx === cursor
              const repoName = run.repoPath.split('/').pop() || ''
              const statusIcon = run.status === 'complete' ? '●' : '◐'
              const statusColor = run.status === 'complete' ? '#a6e3a1' : '#f9e2af'
              const scores = run.scoreProgression.length > 0
                ? run.scoreProgression.map(s => s.toFixed(1)).join(' -> ')
                : ''

              return (
                <box key={run.dir} height={1} backgroundColor={sel ? '#313244' : undefined}>
                  <text>
                    <span fg={sel ? '#cdd6f4' : '#585b70'}>{sel ? '> ' : '  '}</span>
                    <span fg={statusColor}>{statusIcon} </span>
                    <span fg="#cdd6f4">{run.timestamp}</span>
                    <span fg="#6c7086">{' '}{repoName}</span>
                    <span fg="#585b70">{run.featuresCount > 0 ? ` ${run.featuresCount}f` : ''}</span>
                    <span fg="#585b70">{run.roundsCount > 0 ? ` ${run.roundsCount}r` : ''}</span>
                    <span fg="#a6e3a1">{scores ? `  ${scores}` : ''}</span>
                    <span fg="#f9e2af">{run.totalCost > 0 ? `  $${run.totalCost.toFixed(2)}` : ''}</span>
                  </text>
                </box>
              )
            })}
            {runs.length === 0 && <text fg="#6c7086">No past runs found.</text>}
          </box>
        </scrollbox>
      </box>

      <box paddingX={2} height={1}>
        <text fg="#585b70">j/k=move  Enter=open  q=quit</text>
      </box>
    </box>
  )
}

// ============================================================
// Full-screen Diff View
// ============================================================

function DiffView({ title, diff }: { title: string; diff: string }) {
  const lines = diff.split('\n')
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#1e1e2e">
      <box paddingX={1} height={1}>
        <text>
          <span fg="#585b70">{'< '}</span>
          <span fg="#89b4fa" attributes={1}>{title}</span>
          <span fg="#6c7086">{' '}{lines.length} lines</span>
        </text>
      </box>
      <box flexGrow={1} border={true} borderStyle="rounded" borderColor="#45475a">
        <scrollbox scrollY={true} flexGrow={1}>
          <box flexDirection="column" paddingX={1}>
            {lines.map((line, i) => {
              const fg = line.startsWith('+++') || line.startsWith('---') ? '#cba6f7'
                : line.startsWith('+') ? '#a6e3a1'
                : line.startsWith('-') ? '#f38ba8'
                : line.startsWith('@@') ? '#89b4fa'
                : line.startsWith('diff') ? '#cba6f7'
                : '#a6adc8'
              return <text key={i} fg={fg}>{line || ' '}</text>
            })}
          </box>
        </scrollbox>
      </box>
      <box paddingX={2} height={1}>
        <text fg="#585b70">Esc=back  q=quit</text>
      </box>
    </box>
  )
}

// ============================================================
// Main App — view router + event handler + keyboard nav
// ============================================================

export function App({ startView, onLoadRun }: { startView?: View['type']; onLoadRun?: (dir: string) => void }) {
  const _onLoadRun = onLoadRun || ((_dir: string) => {})
  const [state, setState] = useState<RunState>(initialState)
  const [view, setView] = useState<View>({ type: startView || 'dashboard' } as View)
  const [prevView, setPrevView] = useState<View | null>(null)
  const [cursor, setCursor] = useState(0)
  const [fileCursor, setFileCursor] = useState(0)
  const [selectedRound, setSelectedRound] = useState(0)
  const [logData, setLogData] = useState<LogDirData | null>(null)
  const [pickerRuns, setPickerRuns] = useState<RunInfo[]>([])
  const { width, height } = useTerminalDimensions()

  // Load picker runs on mount if starting in picker
  useEffect(() => {
    if (startView === 'run_picker') {
      setPickerRuns(scanRunDirs())
    }
  }, [])

  // Timer for elapsed display
  useEffect(() => {
    const timer = setInterval(() => {
      setState(prev => ({ ...prev, elapsed: formatElapsed(Date.now() - prev.startTime) }))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // Periodically reload log dir data (for drill-down views)
  useEffect(() => {
    const timer = setInterval(() => {
      if (state.logDir) {
        try {
          setLogData(loadLogDir(state.logDir))
        } catch {}
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [state.logDir])

  // Subscribe to events
  useEffect(() => {
    const handler = (stamped: TimestampedEvent) => {
      const { event, ts } = stamped

      setState(prev => {
        const next = { ...prev }
        next.features = new Map(prev.features)
        next.roundScores = new Map(prev.roundScores)
        next.logs = [...prev.logs]
        next.scoreProgression = [...prev.scoreProgression]
        next.featureOrder = [...prev.featureOrder]

        switch (event.type) {
          case 'run_start':
            next.repoPath = event.repoPath
            next.logDir = event.logDir
            next.n = event.n
            next.loops = event.loops
            next.codingModel = event.codingModel
            next.docsModel = event.docsModel
            next.startTime = Date.now()
            next.logs.push({ ts, message: `Run started — ${event.repoPath}`, level: 'info' })
            // Load log dir data
            try { setLogData(loadLogDir(event.logDir)) } catch {}
            break

          case 'phase_change':
            next.phase = event.phase
            if (event.round !== undefined) next.round = event.round
            if (event.loop !== undefined) next.loop = event.loop
            next.phaseDetail = event.detail || ''
            next.logs.push({ ts, message: `Phase: ${phaseLabel(event.phase, event.round ?? next.round, event.loop ?? next.loop)}${event.detail ? ` — ${event.detail}` : ''}`, level: 'info' })
            break

          case 'feature_planned':
            next.logs.push({ ts, message: `${event.totalCandidates} candidates, ${event.selectedIds.length} selected`, level: 'info' })
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
            if (!next.featureOrder.includes(event.featureId)) next.featureOrder.push(event.featureId)

            const statusMsg: Record<string, string> = {
              carving: `Carving ${event.featureId}...`,
              carved: `Carved ${event.featureId}`,
              carve_failed: `Carve failed: ${event.featureId}`,
              agent_running: `Agent on ${event.featureId}`,
              judging: `Judging ${event.featureId}...`,
              scored: `${event.featureId}: ${event.score?.toFixed(1)}/10`,
              eval_failed: `Eval failed: ${event.featureId}`,
            }
            if (statusMsg[event.status]) {
              next.logs.push({ ts, message: statusMsg[event.status], level: event.status.includes('fail') ? 'error' : 'info' })
            }
            break
          }

          case 'round_complete':
            next.roundScores.set(event.round, event.avgScore)
            next.totalCost = event.totalCost
            next.scoreProgression.push(event.avgScore)
            next.logs.push({ ts, message: `Round ${event.round}: avg ${event.avgScore.toFixed(1)}/10, $${event.totalCost.toFixed(2)}`, level: 'info' })
            for (const [id, f] of next.features) {
              if (f.status === 'scored' || f.status === 'eval_failed') {
                next.features.set(id, { ...f, status: 'pending' })
              }
            }
            // Reload log data to get round results
            if (next.logDir) { try { setLogData(loadLogDir(next.logDir)) } catch {} }
            break

          case 'docs_refactor':
            next.logs.push({ ts, message: event.action === 'start' ? `Docs refactor loop ${event.loop} (${event.suggestionCount || 0} suggestions)` : `Docs refactor loop ${event.loop} done`, level: 'info' })
            break

          case 'run_complete':
            next.done = true
            next.phase = 'complete'
            next.phaseDetail = ''
            next.totalCost = event.totalCost
            next.scoreProgression = event.scoreProgression
            next.logs.push({ ts, message: `Done! ${event.scoreProgression.map(s => s.toFixed(1)).join(' -> ')} $${event.totalCost.toFixed(2)}`, level: 'info' })
            if (next.logDir) { try { setLogData(loadLogDir(next.logDir)) } catch {} }
            break

          case 'log':
            next.logs.push({ ts, message: event.message, level: event.level })
            break
        }

        if (next.logs.length > 500) next.logs = next.logs.slice(-400)
        return next
      })
    }

    events.replay(handler)
    events.on('event', handler)
    return () => { events.off('event', handler) }
  }, [])

  // Keyboard navigation
  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      process.exit(0)
    }

    if (key.name === 'escape') {
      if (view.type === 'diff') {
        setView(prevView || { type: 'dashboard' })
        setPrevView(null)
      } else if (view.type === 'judging') {
        setView({ type: 'feature', featureId: view.featureId })
      } else if (view.type === 'run_picker') {
        // If we have a run loaded, go to dashboard; otherwise stay
        if (state.repoPath) setView({ type: 'dashboard' })
      } else if (view.type !== 'dashboard') {
        setView({ type: 'dashboard' })
        setCursor(0)
      }
      return
    }

    // Run picker navigation
    if (view.type === 'run_picker') {
      const maxIdx = pickerRuns.length - 1
      if ((key.name === 'j' || key.name === 'down') && cursor < maxIdx) {
        setCursor(c => Math.min(c + 1, maxIdx))
      } else if ((key.name === 'k' || key.name === 'up') && cursor > 0) {
        setCursor(c => Math.max(c - 1, 0))
      } else if (key.name === 'return' && pickerRuns[cursor]) {
        _onLoadRun(pickerRuns[cursor].dir)
        setView({ type: 'dashboard' })
        setCursor(0)
      }
      return
    }

    // View-specific keys
    if (view.type === 'dashboard') {
      const maxIdx = state.featureOrder.length - 1
      if ((key.name === 'j' || key.name === 'down') && cursor < maxIdx) {
        setCursor(c => Math.min(c + 1, maxIdx))
      } else if ((key.name === 'k' || key.name === 'up') && cursor > 0) {
        setCursor(c => Math.max(c - 1, 0))
      } else if (key.name === 'return' && state.featureOrder[cursor]) {
        setView({ type: 'feature', featureId: state.featureOrder[cursor] })
        setSelectedRound(0)
        setFileCursor(0)
      } else if (key.name === 's') {
        setView({ type: 'summary' })
      } else if (key.name === 'r') {
        setView({ type: 'round', round: 0 })
        setCursor(0)
      } else if (key.name === 'p') {
        setPickerRuns(scanRunDirs())
        setView({ type: 'run_picker' })
        setCursor(0)
      }
    } else if (view.type === 'feature') {
      const feature = logData?.features.find(ft => ft.id === view.featureId)
      const ops = feature?.operations || []
      const maxRound = Math.max(0, ...Array.from(state.roundScores.keys()))

      if (key.name === 'tab') {
        setSelectedRound(r => Math.min(r + 1, maxRound))
      } else if ((key.name === 'j' || key.name === 'down') && fileCursor < ops.length - 1) {
        setFileCursor(c => c + 1)
      } else if ((key.name === 'k' || key.name === 'up') && fileCursor > 0) {
        setFileCursor(c => c - 1)
      } else if (key.name === 'l' || key.name === 'right') {
        setSelectedRound(r => Math.min(r + 1, maxRound))
      } else if (key.name === 'h' || key.name === 'left') {
        setSelectedRound(r => Math.max(r - 1, 0))
      } else if (key.name === 'return') {
        // Enter on a file: show full diff for that file from carve diff
        if (ops[fileCursor] && feature?.diff) {
          const filePath = ops[fileCursor].path
          const fileDiff = extractFileDiff(feature.diff, filePath)
          if (fileDiff) {
            setPrevView(view)
            setView({ type: 'diff', title: `${filePath} (feature code)`, diff: invertDiff(fileDiff) })
          }
        } else if (feature?.diff) {
          setPrevView(view)
          setView({ type: 'diff', title: `${view.featureId} (feature code)`, diff: invertDiff(feature.diff) })
        }
      } else if (key.name === 'd') {
        // 'd' for agent diff of current round
        const roundData = logData?.rounds[selectedRound]
        const featureRound = roundData?.features.find(rf => rf.featureId === view.featureId)
        if (featureRound?.diff) {
          setPrevView(view)
          setView({ type: 'diff', title: `${view.featureId} agent diff (R${selectedRound})`, diff: featureRound.diff })
        }
      }
    } else if (view.type === 'round') {
      const maxRound = Math.max(0, (logData?.rounds.length ?? 1) - 1)
      const features = logData?.rounds[view.round]?.features ?? []
      if ((key.name === 'j' || key.name === 'down') && cursor < features.length - 1) {
        setCursor(c => c + 1)
      } else if ((key.name === 'k' || key.name === 'up') && cursor > 0) {
        setCursor(c => c - 1)
      } else if (key.name === 'l' || key.name === 'right' || key.name === 'tab') {
        const nextRound = Math.min(view.round + 1, maxRound)
        setView({ type: 'round', round: nextRound })
        setCursor(0)
      } else if (key.name === 'h' || key.name === 'left') {
        const prevRound = Math.max(view.round - 1, 0)
        setView({ type: 'round', round: prevRound })
        setCursor(0)
      } else if (key.name === 'return' && features[cursor]) {
        setView({ type: 'feature', featureId: features[cursor].featureId })
        setSelectedRound(view.round)
      }
    }
  })

  // Render active view
  switch (view.type) {
    case 'run_picker':
      return (
        <RunPickerView
          runs={pickerRuns}
          cursor={cursor}
          onSelect={(dir) => { _onLoadRun(dir); setView({ type: 'dashboard' }); setCursor(0) }}
        />
      )
    case 'dashboard':
      return (
        <DashboardView
          state={state}
          cursor={cursor}
          onSelect={(id) => { setView({ type: 'feature', featureId: id }); setSelectedRound(0) }}
        />
      )
    case 'feature':
      return (
        <FeatureDetailView
          featureId={view.featureId}
          state={state}
          logData={logData}
          selectedRound={selectedRound}
          fileCursor={fileCursor}
          onViewDiff={(title, diff) => setView({ type: 'diff', title, diff })}
        />
      )
    case 'round':
      return (
        <RoundDetailView
          round={view.round}
          state={state}
          logData={logData}
          cursor={cursor}
          onBack={() => setView({ type: 'dashboard' })}
        />
      )
    case 'summary':
      return (
        <SummaryView
          state={state}
          logData={logData}
          onBack={() => setView({ type: 'dashboard' })}
        />
      )
    case 'diff':
      return (
        <DiffView
          title={view.title}
          diff={view.diff}
        />
      )
  }
}
