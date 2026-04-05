import fs from 'fs'
import path from 'path'

import { compressAndSave } from './trace-compressor'

import type { TaskResult } from './eval-runner'
import type { JudgingResult } from './judge'

export interface RoundResult {
  round: number
  tasks: TaskResult[]
  avgScore: number
  totalCost: number
}

export interface EvalSummary {
  repoPath: string
  startTime: string
  endTime: string
  featuresCarved: number
  rounds: Array<{
    round: number
    avgScore: number
    scores: Record<string, number>
    totalCost: number
  }>
  totalCost: number
  scoreProgression: number[]
  // Baseline re-judged after each loop's docs update. Index 0 corresponds to
  // loop 1 (first re-judge), etc. The original baseline score is already in
  // scoreProgression[0]. A flat or rising line here with a rising agent line
  // suggests the docs are improving the agent beyond just judge recalibration.
  baselineRejudgeProgression?: number[]
}

export interface EvalOptions {
  loops: number
  codingModel: string
  docsModel: string
}

export function saveBaselineRejudgeResults(logDir: string, roundResult: RoundResult): void {
  // Persist rejudged-baseline results in a sibling directory so they don't
  // collide with the normal per-round directories.
  const roundDir = path.join(logDir, `baseline-rejudge-loop-${roundResult.round}`)
  fs.mkdirSync(roundDir, { recursive: true })

  for (const task of roundResult.tasks) {
    const taskDir = path.join(roundDir, task.featureId)
    fs.mkdirSync(taskDir, { recursive: true })
    // We don't re-persist the trace/diff — those are identical to baseline.
    fs.writeFileSync(path.join(taskDir, 'judging.json'), JSON.stringify(task.judging, null, 2))
    fs.writeFileSync(path.join(taskDir, 'score.txt'), task.score.toString())
  }

  const summary = {
    loop: roundResult.round,
    avgScore: roundResult.avgScore,
    tasks: roundResult.tasks.map((t) => ({
      featureId: t.featureId,
      score: t.score,
    })),
  }
  fs.writeFileSync(path.join(roundDir, 'summary.json'), JSON.stringify(summary, null, 2))
}

export function saveRoundResults(logDir: string, roundResult: RoundResult): void {
  const roundDir = path.join(logDir, `round-${roundResult.round}`)
  fs.mkdirSync(roundDir, { recursive: true })

  for (const task of roundResult.tasks) {
    const taskDir = path.join(roundDir, task.featureId)
    fs.mkdirSync(taskDir, { recursive: true })

    const tracePath = path.join(taskDir, 'trace.txt')
    fs.writeFileSync(tracePath, task.trace)
    // Compress the raw trace in the background (fire-and-forget) so large
    // tool outputs don't bloat the log directory.  The compressed file is
    // written alongside the raw trace as trace.txt.compressed and sidecars
    // live in trace.txt.sidecars/.
    compressAndSave(tracePath, task.trace).catch((err: unknown) => {
      console.warn(`[report] Failed to compress trace for ${task.featureId}: ${err}`)
    })

    fs.writeFileSync(path.join(taskDir, 'diff.txt'), task.diff)
    fs.writeFileSync(path.join(taskDir, 'judging.json'), JSON.stringify(task.judging, null, 2))
    fs.writeFileSync(path.join(taskDir, 'score.txt'), task.score.toString())
  }

  const summary = {
    round: roundResult.round,
    avgScore: roundResult.avgScore,
    totalCost: roundResult.totalCost,
    tasks: roundResult.tasks.map((t) => ({
      featureId: t.featureId,
      score: t.score,
      costEstimate: t.costEstimate,
    })),
  }
  fs.writeFileSync(path.join(roundDir, 'summary.json'), JSON.stringify(summary, null, 2))
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  const mins = Math.floor(ms / 60000)
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hrs > 0) return `${hrs}h ${remainMins}m`
  return `${mins}m`
}

export function saveSummary(
  logDir: string,
  summary: EvalSummary,
  roundResults: RoundResult[],
  opts: EvalOptions,
  baselineRejudgeResults: RoundResult[] = [],
): void {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2))

  const L: string[] = []
  const push = (...s: string[]) => L.push(...s)

  // --- Header ---
  push(
    '# Evalbuff Run Report',
    '',
    '## Overview',
    '',
    `| | |`,
    `|---|---|`,
    `| **Repo** | \`${summary.repoPath}\` |`,
    `| **Start** | ${summary.startTime} |`,
    `| **End** | ${summary.endTime} |`,
    `| **Duration** | ${formatDuration(summary.startTime, summary.endTime)} |`,
    `| **Features carved** | ${summary.featuresCarved} |`,
    `| **Improvement loops** | ${opts.loops} |`,
    `| **Coding model** | ${opts.codingModel} |`,
    `| **Docs model** | ${opts.docsModel} |`,
    `| **Total cost** | $${summary.totalCost.toFixed(2)} |`,
    '',
  )

  // --- Score trajectory ---
  push('## Score Trajectory', '')
  push('```')
  for (let i = 0; i < summary.scoreProgression.length; i++) {
    const score = summary.scoreProgression[i]
    const bar = '█'.repeat(Math.round(score * 2))
    const label = i === 0 ? 'baseline' : `loop ${i}`
    push(`${label.padEnd(12)} ${score.toFixed(1).padStart(5)}/10  ${bar}`)
  }
  push('```')

  const delta = summary.scoreProgression.length >= 2
    ? summary.scoreProgression[summary.scoreProgression.length - 1] - summary.scoreProgression[0]
    : 0
  if (delta !== 0) {
    push('', `**Net change:** ${delta > 0 ? '+' : ''}${delta.toFixed(1)} points`)
  }
  push('')

  // --- Baseline rejudge trajectory ---
  // Same baseline diffs, re-scored after each loop's docs update. Disentangles
  // judge recalibration from real agent improvement.
  if (summary.baselineRejudgeProgression && summary.baselineRejudgeProgression.length > 0) {
    push('## Baseline Rejudge Trajectory', '')
    push('_Same baseline diffs, re-scored after each loop\'s docs update._', '')
    push('```')
    // Include the original baseline score as loop 0 for reference alignment.
    push(`${'baseline'.padEnd(12)} ${summary.scoreProgression[0].toFixed(1).padStart(5)}/10  ${'█'.repeat(Math.round(summary.scoreProgression[0] * 2))}`)
    for (let i = 0; i < summary.baselineRejudgeProgression.length; i++) {
      const score = summary.baselineRejudgeProgression[i]
      const bar = '█'.repeat(Math.round(score * 2))
      push(`${('loop ' + (i + 1)).padEnd(12)} ${score.toFixed(1).padStart(5)}/10  ${bar}`)
    }
    push('```')

    const judgeDelta = summary.baselineRejudgeProgression[summary.baselineRejudgeProgression.length - 1] - summary.scoreProgression[0]
    const agentDelta = delta - judgeDelta
    push(
      '',
      `**Judge recalibration (docs → baseline diffs):** ${judgeDelta > 0 ? '+' : ''}${judgeDelta.toFixed(1)} points`,
      `**Estimated agent improvement (net − judge recalibration):** ${agentDelta > 0 ? '+' : ''}${agentDelta.toFixed(1)} points`,
      '',
    )
  }

  // --- Per-round score table ---
  push('## Scores by Round', '')

  const featureIds = [...new Set(roundResults.flatMap((r) => r.tasks.map((t) => t.featureId)))]
  const headerCols = ['Feature', ...roundResults.map((r) => r.round === 0 ? 'Baseline' : `Loop ${r.round}`)]
  push(`| ${headerCols.join(' | ')} |`)
  push(`| ${headerCols.map(() => '---').join(' | ')} |`)

  for (const fid of featureIds) {
    const scores = roundResults.map((r) => {
      const task = r.tasks.find((t) => t.featureId === fid)
      if (!task || task.score < 0) return 'FAIL'
      return task.score.toFixed(1)
    })
    push(`| ${fid} | ${scores.join(' | ')} |`)
  }

  const avgRow = roundResults.map((r) => r.avgScore.toFixed(1))
  push(`| **Average** | ${avgRow.join(' | ')} |`)

  const costRow = roundResults.map((r) => `$${r.totalCost.toFixed(2)}`)
  push(`| **Cost** | ${costRow.join(' | ')} |`)
  push('')

  // --- Baseline rejudge table (parallel scoring of the same baseline diffs) ---
  if (baselineRejudgeResults.length > 0) {
    push('## Baseline Scored by Each Loop\'s Docs', '')
    push('_Baseline agent diffs held constant; only the docs the judge sees change._', '')
    const rjHeader = ['Feature', 'Baseline', ...baselineRejudgeResults.map((r) => `Loop ${r.round}`)]
    push(`| ${rjHeader.join(' | ')} |`)
    push(`| ${rjHeader.map(() => '---').join(' | ')} |`)
    for (const fid of featureIds) {
      const baselineTask = roundResults[0].tasks.find((t) => t.featureId === fid)
      const baselineCell = !baselineTask || baselineTask.score < 0 ? 'FAIL' : baselineTask.score.toFixed(1)
      const loopCells = baselineRejudgeResults.map((r) => {
        const task = r.tasks.find((t) => t.featureId === fid)
        if (!task || task.score < 0) return 'FAIL'
        return task.score.toFixed(1)
      })
      push(`| ${fid} | ${baselineCell} | ${loopCells.join(' | ')} |`)
    }
    const rjAvgRow = [
      roundResults[0].avgScore.toFixed(1),
      ...baselineRejudgeResults.map((r) => r.avgScore.toFixed(1)),
    ]
    push(`| **Average** | ${rjAvgRow.join(' | ')} |`)
    push('')
  }

  // --- Per-round detail ---
  for (const round of roundResults) {
    const roundLabel = round.round === 0 ? 'Baseline' : `Loop ${round.round}`
    push(`## ${roundLabel} — Detail`, '')

    for (const task of round.tasks) {
      push(`### ${task.featureId} — ${task.score >= 0 ? `${task.score.toFixed(1)}/10` : 'FAILED'}`, '')

      if (task.score < 0) {
        push(`> Agent failed: ${task.judging.analysis.slice(0, 200)}`, '')
        continue
      }

      // Score breakdown
      push(
        `| Completion | Code Quality | E2E | Overall |`,
        `|---|---|---|---|`,
        `| ${task.judging.completionScore.toFixed(1)} | ${task.judging.codeQualityScore.toFixed(1)} | ${task.judging.e2eScore.toFixed(1)} | ${task.judging.overallScore.toFixed(1)} |`,
        '',
      )

      // Analysis
      push(`**Analysis:** ${task.judging.analysis}`, '')

      // Strengths & weaknesses
      if (task.judging.strengths.length > 0) {
        push('**Strengths:**')
        for (const s of task.judging.strengths) push(`- ${s}`)
        push('')
      }
      if (task.judging.weaknesses.length > 0) {
        push('**Weaknesses:**')
        for (const w of task.judging.weaknesses) push(`- ${w}`)
        push('')
      }

      // E2E tests performed
      if (task.judging.e2eTestsPerformed.length > 0) {
        push('**E2E tests performed:**')
        for (const t of task.judging.e2eTestsPerformed) push(`- ${t}`)
        push('')
      }

      // Docs read
      if (task.docsRead.length > 0) {
        push(`**Docs read:** ${task.docsRead.map(d => `\`${d}\``).join(', ')}`, '')
      } else {
        push('**Docs read:** none', '')
      }

      // Doc suggestions
      const suggestions = task.judging.docSuggestions
      if (suggestions && suggestions.length > 0) {
        push('**Doc suggestions:**')
        for (const s of suggestions) push(`- ${s}`)
        push('')
      }

      push(`**Cost:** $${task.costEstimate.toFixed(2)}`, '')
    }

    // Judge suggestions file for non-baseline rounds
    if (round.round > 0) {
      const suggestionsFile = path.join(logDir, `judge-suggestions-loop-${round.round}.txt`)
      if (fs.existsSync(suggestionsFile)) {
        const suggestionsText = fs.readFileSync(suggestionsFile, 'utf-8')
        if (suggestionsText.trim()) {
          push(`### Judge Suggestions Applied (Loop ${round.round})`, '')
          push('```')
          push(suggestionsText)
          push('```', '')
        }
      }
    }

    // Docs diff for non-baseline rounds
    if (round.round > 0) {
      const diffFile = path.join(logDir, `docs-diff-loop-${round.round}.txt`)
      if (fs.existsSync(diffFile)) {
        const diffText = fs.readFileSync(diffFile, 'utf-8')
        if (diffText.trim()) {
          push(`### Docs Changes (Loop ${round.round})`, '')
          push('```diff')
          push(diffText)
          push('```', '')
        }
      }
    }
  }

  // --- Final docs state ---
  const lastLoop = opts.loops
  const finalDocsFile = path.join(logDir, `docs-state-loop-${lastLoop}.json`)
  if (fs.existsSync(finalDocsFile)) {
    const finalDocs: Record<string, string> = JSON.parse(fs.readFileSync(finalDocsFile, 'utf-8'))
    const docKeys = Object.keys(finalDocs).sort()
    if (docKeys.length > 0) {
      push('## Final Documentation State', '')
      for (const key of docKeys) {
        push(`### ${key}`, '')
        push('```markdown')
        push(finalDocs[key])
        push('```', '')
      }
    }
  }

  fs.writeFileSync(path.join(logDir, 'report.md'), L.join('\n'))
}
