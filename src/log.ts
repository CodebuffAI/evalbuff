/**
 * Compact, streaming-friendly console output for evalbuff runs.
 *
 * All detailed data goes to disk logs — this module handles only
 * what the user sees in the terminal during a run.
 */

import { roundLabel } from './report'

import type { TaskResult } from './eval-runner'

// --- Spinners & progress ---

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let spinnerIdx = 0
let spinnerInterval: ReturnType<typeof setInterval> | null = null
let currentSpinnerLine = ''

export function startSpinner(message: string): void {
  stopSpinner()
  currentSpinnerLine = message
  spinnerIdx = 0
  const write = () => {
    process.stderr.write(`\r${SPINNER[spinnerIdx % SPINNER.length]} ${currentSpinnerLine}`)
    spinnerIdx++
  }
  write()
  spinnerInterval = setInterval(write, 80)
}

export function updateSpinner(message: string): void {
  currentSpinnerLine = message
}

export function stopSpinner(finalMessage?: string): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval)
    spinnerInterval = null
  }
  if (currentSpinnerLine || finalMessage) {
    process.stderr.write(`\r\x1b[K`) // clear line
    if (finalMessage) {
      process.stderr.write(finalMessage + '\n')
    }
    currentSpinnerLine = ''
  }
}

// --- Score formatting ---

function scoreBar(score: number, width: number = 10): string {
  if (score < 0) return '\x1b[31mFAIL\x1b[0m'
  const filled = Math.round((score / 10) * width)
  const empty = width - filled
  const color = score >= 8 ? '\x1b[32m' : score >= 5 ? '\x1b[33m' : '\x1b[31m'
  return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}\x1b[0m ${score.toFixed(1)}`
}

function scoreDelta(before: number, after: number): string {
  const d = after - before
  if (Math.abs(d) < 0.05) return ''
  const sign = d > 0 ? '+' : ''
  const color = d > 0 ? '\x1b[32m' : '\x1b[31m'
  return ` ${color}(${sign}${d.toFixed(1)})\x1b[0m`
}

// --- Phase output ---

export function printHeader(opts: {
  repoPath: string
  n: number
  codingModel: string
  docsModel: string
  logDir: string
}): void {
  console.log(`\n\x1b[1mEvalbuff Run\x1b[0m`)
  console.log(`  Repo: ${opts.repoPath}`)
  console.log(`  Features: ${opts.n} | Models: ${opts.codingModel}/${opts.docsModel}`)
  console.log(`  Logs: ${opts.logDir}`)
}

export function printRoundScores(
  label: string,
  results: TaskResult[],
  avgScore: number,
  totalCost: number,
  baselineAvg?: number,
): void {
  console.log(`\n  \x1b[1m${label}\x1b[0m`)
  for (const r of results) {
    console.log(`    ${r.featureId.padEnd(30)} ${scoreBar(r.score)}`)
  }
  const valid = results.filter(r => r.score >= 0)
  const delta = baselineAvg !== undefined ? scoreDelta(baselineAvg, avgScore) : ''
  console.log(`    ${'Average'.padEnd(30)} ${avgScore.toFixed(1)}/10${delta}  (${valid.length}/${results.length} ok, $${totalCost.toFixed(2)})`)
}

export function printBaselineRejudge(avgScore: number, originalBaseline: number): void {
  const delta = scoreDelta(originalBaseline, avgScore)
  console.log(`  Baseline rejudge: ${avgScore.toFixed(1)}/10${delta} (same diffs, updated docs)`)
}

// --- Score table ---

export function printScoreTable(
  roundResults: Array<{ round: number; tasks: TaskResult[]; avgScore: number }>,
  baselineRejudgeResults: Array<{ round: number; avgScore: number }> = [],
): void {
  if (roundResults.length === 0) return

  const featureIds = [...new Set(roundResults.flatMap(r => r.tasks.map(t => t.featureId)))]
  const colLabels = roundResults.map(r => {
    const label = roundLabel(r.round, roundResults.length)
    if (label === 'Baseline') return 'Base'
    if (label === 'Final') return 'Final'
    return `L${r.round}`
  })

  const maxIdLen = Math.max(...featureIds.map(f => f.length), 16) // 16 for "Baseline rejudge"
  const colWidth = 6
  const divider = `  ${'─'.repeat(maxIdLen)}  ${colLabels.map(() => '─'.repeat(colWidth)).join(' ')}`

  console.log(`\n\x1b[1mScore Progression\x1b[0m`)
  console.log(`  ${'Feature'.padEnd(maxIdLen)}  ${colLabels.map(c => c.padStart(colWidth)).join(' ')}`)
  console.log(divider)

  for (const fid of featureIds) {
    const scores = roundResults.map(r => {
      const task = r.tasks.find(t => t.featureId === fid)
      if (!task || task.score < 0) return '  FAIL'
      return task.score.toFixed(1).padStart(colWidth)
    })
    console.log(`  ${fid.padEnd(maxIdLen)}  ${scores.join(' ')}`)
  }

  console.log(divider)

  const avgs = roundResults.map(r => r.avgScore.toFixed(1).padStart(colWidth))
  console.log(`  \x1b[1m${'Average'.padEnd(maxIdLen)}\x1b[0m  ${avgs.join(' ')}`)

  // Baseline rejudge row
  if (baselineRejudgeResults.length > 0) {
    const baseScore = roundResults[0].avgScore
    const rjCells = [baseScore.toFixed(1).padStart(colWidth)]
    for (const rj of baselineRejudgeResults) {
      rjCells.push(rj.avgScore.toFixed(1).padStart(colWidth))
    }
    console.log(`  \x1b[90m${'Baseline rejudge'.padEnd(maxIdLen)}\x1b[0m  ${rjCells.join(' ')}`)
  }
}

// --- Project prompts ---

export function printProjectPrompts(prompts: string[]): void {
  if (prompts.length === 0) return

  console.log(`\n\x1b[1mProject Improvement Prompts\x1b[0m (${prompts.length})\n`)
  for (let i = 0; i < prompts.length; i++) {
    console.log(`\x1b[1m--- Prompt ${i + 1}/${prompts.length} ---\x1b[0m`)
    console.log(prompts[i])
    console.log()
  }
}

// --- Final summary ---

export function printFinalSummary(opts: {
  startTime: string
  endTime: string
  features: number
  totalCost: number
  scoreProgression: number[]
  baselineRejudgeProgression: number[]
  promptCount: number
  logDir: string
  reportPath: string
}): void {
  const ms = new Date(opts.endTime).getTime() - new Date(opts.startTime).getTime()
  const mins = Math.floor(ms / 60000)
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  const duration = hrs > 0 ? `${hrs}h ${remainMins}m` : `${mins}m`

  const scores = opts.scoreProgression
  const progression = scores.map(s => s.toFixed(1)).join(' → ')

  console.log(`\n\x1b[1m${'═'.repeat(50)}\x1b[0m`)
  console.log(`\x1b[1mRUN COMPLETE\x1b[0m`)
  console.log(`  Score: ${progression}`)

  if (opts.baselineRejudgeProgression.length > 0) {
    const rjLast = opts.baselineRejudgeProgression[opts.baselineRejudgeProgression.length - 1]
    const judgeDrift = rjLast - scores[0]
    const agentImprovement = (scores[scores.length - 1] - scores[0]) - judgeDrift

    const agentStr = agentImprovement > 0.05
      ? `\x1b[32m+${agentImprovement.toFixed(1)}\x1b[0m`
      : agentImprovement < -0.05
        ? `\x1b[31m${agentImprovement.toFixed(1)}\x1b[0m`
        : `${agentImprovement.toFixed(1)}`

    console.log(`  Baseline rejudge drift: ${scores[0].toFixed(1)} → ${rjLast.toFixed(1)}`)
    console.log(`  \x1b[1mReal agent improvement: ${agentStr}\x1b[0m (score delta minus judge drift)`)
  }

  console.log(`  Features: ${opts.features} | Duration: ${duration} | Cost: $${opts.totalCost.toFixed(2)}`)
  if (opts.promptCount > 0) {
    console.log(`  Project prompts: ${opts.promptCount}`)
  }
  console.log(`  Report: ${opts.reportPath}`)
}
