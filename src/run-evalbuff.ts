/**
 * Evalbuff — iterative documentation optimization through feature carving.
 *
 * Pipeline:
 *   1. Plan features to carve (GPT-5.4 via Codex SDK)
 *   2. Carve a random subset of n features
 *   3. Baseline: rebuild each in parallel (Claude Code), judge (Codex), get scores + doc suggestions
 *   4. Loop N times:
 *      a. Docs refactor agent reads judge suggestions and edits all docs holistically
 *      b. Re-eval: rebuild in parallel, judge, get new scores + doc suggestions
 *
 * Usage:
 *   bun run src/run-evalbuff.ts --repo /path/to/repo [--n 5] [--parallelism 10] [--loops 3] [--init-command "npm install"]
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import { planFeatures, carveFeature } from './carve-features'
import { collectDocSuggestions, collectProjectSuggestions, runDocsWriterAgent, runPromptWriterAgent } from './docs-writer'
import { selectRandom, getGroundTruthDiff, getDocsSnapshot, computeDocsDiffText } from './eval-helpers'
import { runAgentOnCarve, rejudgeBaselineWithCurrentDocs } from './eval-runner'
import {
  startSpinner, updateSpinner, stopSpinner,
  printHeader, printRoundScores, printBaselineRejudge,
  printScoreTable, printProjectPrompts, printFinalSummary,
} from './log'
import { saveRoundResults, saveBaselineRejudgeResults, saveSummary } from './report'
import { events } from './tui/events'

import type { CarvedFeature } from './carve-features'
import type { TaskResult } from './eval-runner'
import type { RoundResult, EvalSummary } from './report'

// --- Types ---

export interface EvalbuffOptions {
  repoPath: string
  n: number            // number of features to randomly select
  parallelism: number  // parallel agent runs per eval round
  loops: number        // number of improvement loops (default 3)
  initCommand?: string
  codingModel: string  // model for coding agents (default: sonnet)
  docsModel: string    // model for docs agents (default: opus)
  cachedFeatures?: string  // path to a features.json from a previous run
}

// --- Eval round ---

async function runEvalRound(
  features: CarvedFeature[],
  groundTruthDiffs: Map<string, string>,
  opts: EvalbuffOptions,
  round: number,
  baselineAvg?: number,
): Promise<RoundResult> {
  const label = round === 0 ? 'Baseline' : `Round ${round}`
  let completed = 0

  startSpinner(`${label}: evaluating 0/${features.length} features...`)

  // Run features with bounded concurrency
  const results: TaskResult[] = []
  const queue = features.map((feature, i) => ({ feature, i }))
  let next = 0

  async function worker(): Promise<void> {
    while (next < queue.length) {
      const { feature, i } = queue[next++]
      try {
        events.send({ type: 'feature_status', featureId: feature.id, status: 'agent_running' })
        const result = await runAgentOnCarve({
          idx: i,
          total: features.length,
          repoPath: opts.repoPath,
          feature,
          initCommand: opts.initCommand,
          model: opts.codingModel,
          groundTruthDiff: groundTruthDiffs.get(feature.id) || '',
          docsSourcePath: opts.repoPath,
        })
        results[i] = result
        events.send({ type: 'feature_status', featureId: feature.id, status: 'scored', score: result.score, cost: result.costEstimate })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        results[i] = {
          featureId: feature.id,
          prompt: feature.prompt,
          score: -1,
          diff: '',
          trace: `Agent error: ${msg}`,
          judging: {
            analysis: `Agent failed: ${msg.slice(0, 500)}`,
            strengths: [],
            weaknesses: ['Agent failed due to infrastructure error'],
            e2eTestsPerformed: [],
            completionScore: -1,
            codeQualityScore: -1,
            e2eScore: -1,
            overallScore: -1,
          },
          costEstimate: 0,
          docsRead: [],
        }
        events.send({ type: 'feature_status', featureId: feature.id, status: 'eval_failed', detail: msg.slice(0, 200) })
      }
      completed++
      updateSpinner(`${label}: ${completed}/${features.length} features evaluated`)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opts.parallelism, features.length) }, () => worker()),
  )

  stopSpinner()

  const valid = results.filter((r) => r.score >= 0)
  const avgScore = valid.length > 0
    ? valid.reduce((a, r) => a + r.score, 0) / valid.length
    : 0
  const totalCost = results.reduce((a, r) => a + r.costEstimate, 0)

  printRoundScores(label, results, avgScore, totalCost, baselineAvg)

  events.send({
    type: 'round_complete',
    round,
    avgScore,
    totalCost,
    scores: Object.fromEntries(results.map(r => [r.featureId, r.score])),
  })

  return { round, tasks: results, avgScore, totalCost }
}

// --- Baseline rejudge round ---
//
// Re-runs the judge on the baseline's stored diffs/traces after docs have been
// updated. The agent's work is fixed — only the docs given to the judge change.
// This lets us see whether score changes over loops reflect real agent
// improvement or merely judge recalibration from better docs.

async function runBaselineRejudgeRound(
  baseline: RoundResult,
  features: CarvedFeature[],
  groundTruthDiffs: Map<string, string>,
  opts: EvalbuffOptions,
  loop: number,
): Promise<RoundResult> {
  let completed = 0
  startSpinner(`Baseline rejudge: 0/${baseline.tasks.length} re-scored...`)

  const featureById = new Map(features.map(f => [f.id, f]))
  const results: TaskResult[] = []
  const queue = baseline.tasks.map((baselineTask, i) => ({ baselineTask, i }))
  let next = 0

  async function worker(): Promise<void> {
    while (next < queue.length) {
      const { baselineTask, i } = queue[next++]
      const feature = featureById.get(baselineTask.featureId)

      if (!feature || baselineTask.score < 0) {
        results[i] = baselineTask
        completed++
        updateSpinner(`Baseline rejudge: ${completed}/${queue.length} re-scored`)
        continue
      }

      try {
        const judging = await rejudgeBaselineWithCurrentDocs({
          idx: i,
          total: queue.length,
          repoPath: opts.repoPath,
          feature,
          baselineDiff: baselineTask.diff,
          groundTruthDiff: groundTruthDiffs.get(feature.id) || '',
          initCommand: opts.initCommand,
          docsSourcePath: opts.repoPath,
        })
        results[i] = {
          ...baselineTask,
          score: judging.overallScore,
          judging,
          costEstimate: 0,
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        results[i] = {
          ...baselineTask,
          score: -1,
          judging: {
            analysis: `Rejudge failed: ${msg.slice(0, 500)}`,
            strengths: [],
            weaknesses: ['Rejudge failed'],
            e2eTestsPerformed: [],
            completionScore: -1,
            codeQualityScore: -1,
            e2eScore: -1,
            overallScore: -1,
          },
        }
      }
      completed++
      updateSpinner(`Baseline rejudge: ${completed}/${queue.length} re-scored`)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opts.parallelism, queue.length) }, () => worker()),
  )

  stopSpinner()

  const valid = results.filter((r) => r.score >= 0)
  const avgScore = valid.length > 0
    ? valid.reduce((a, r) => a + r.score, 0) / valid.length
    : 0

  printBaselineRejudge(avgScore, baseline.avgScore)

  return { round: loop, tasks: results, avgScore, totalCost: 0 }
}

// --- Main orchestrator ---

export async function runEvalbuff(opts: EvalbuffOptions): Promise<void> {
  const startTime = new Date().toISOString()
  const logDir = path.join(os.tmpdir(), `evalbuff-run-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`)
  fs.mkdirSync(logDir, { recursive: true })

  events.initLog(logDir)
  events.send({
    type: 'run_start',
    repoPath: opts.repoPath,
    n: opts.n,
    loops: opts.loops,
    parallelism: opts.parallelism,
    codingModel: opts.codingModel,
    docsModel: opts.docsModel,
    logDir,
  })

  printHeader({
    repoPath: opts.repoPath,
    n: opts.n,
    loops: opts.loops,
    codingModel: opts.codingModel,
    docsModel: opts.docsModel,
    logDir,
  })

  let features: CarvedFeature[]

  if (opts.cachedFeatures) {
    const cached: CarvedFeature[] = JSON.parse(fs.readFileSync(opts.cachedFeatures, 'utf-8'))
    features = selectRandom(cached, opts.n)
    console.log(`\n  Loaded ${features.length} cached features`)

    events.send({ type: 'feature_planned', totalCandidates: cached.length, selectedIds: features.map(f => f.id) })
    fs.writeFileSync(path.join(logDir, 'features.json'), JSON.stringify(features, null, 2))
  } else {
    events.send({ type: 'phase_change', phase: 'planning', detail: 'Analyzing codebase...' })
    startSpinner('Planning features...')

    const plan = await planFeatures(opts.repoPath)
    stopSpinner(`  Found ${plan.candidates.length} candidates`)

    fs.writeFileSync(path.join(logDir, 'plan.json'), JSON.stringify(plan, null, 2))

    const selected = selectRandom(plan.candidates, opts.n)

    events.send({ type: 'feature_planned', totalCandidates: plan.candidates.length, selectedIds: selected.map(c => c.id) })
    events.send({ type: 'phase_change', phase: 'carving', detail: `Carving ${selected.length} features...` })

    features = []
    {
      const carveQueue = [...selected]
      let carveNext = 0
      let carveCompleted = 0
      const carveResults: (CarvedFeature | null)[] = new Array(carveQueue.length).fill(null)

      startSpinner(`Carving 0/${carveQueue.length} features...`)

      async function carveWorker(): Promise<void> {
        while (carveNext < carveQueue.length) {
          const idx = carveNext++
          const candidate = carveQueue[idx]
          try {
            events.send({ type: 'feature_status', featureId: candidate.id, status: 'carving' })
            const carved = await carveFeature(opts.repoPath, candidate)
            if (carved) {
              carveResults[idx] = carved
              events.send({ type: 'feature_status', featureId: candidate.id, status: 'carved', detail: `${carved.operations.length} file operations` })
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            events.send({ type: 'feature_status', featureId: candidate.id, status: 'carve_failed', detail: msg.slice(0, 200) })
          }
          carveCompleted++
          updateSpinner(`Carving ${carveCompleted}/${carveQueue.length} features...`)
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(opts.parallelism, carveQueue.length) }, () => carveWorker()),
      )
      for (const result of carveResults) {
        if (result) features.push(result)
      }
      stopSpinner(`  Carved ${features.length}/${carveQueue.length} features`)
    }
  }

  if (features.length === 0) {
    console.error('No features were successfully carved. Aborting.')
    return
  }

  // Pre-compute ground truth diffs
  const groundTruthDiffs = new Map<string, string>()
  for (const feature of features) {
    groundTruthDiffs.set(feature.id, getGroundTruthDiff(feature))
  }

  fs.writeFileSync(path.join(logDir, 'features.json'), JSON.stringify(features, null, 2))

  // --- Baseline evaluation ---
  events.send({ type: 'phase_change', phase: 'evaluating', round: 0, detail: 'Baseline' })

  const baseline = await runEvalRound(features, groundTruthDiffs, opts, 0)
  saveRoundResults(logDir, baseline)

  let totalCost = baseline.totalCost
  const roundResults: RoundResult[] = [baseline]
  const baselineRejudgeResults: RoundResult[] = []
  let previousResults = baseline
  const allProjectSuggestionSections: string[] = []

  // Collect project suggestions from baseline
  const baselineProjectSuggestions = collectProjectSuggestions(baseline.tasks.filter(t => t.score >= 0))
  if (baselineProjectSuggestions) allProjectSuggestionSections.push(`## Baseline Round\n\n${baselineProjectSuggestions}`)

  // --- Improvement loops ---
  for (let loop = 1; loop <= opts.loops; loop++) {
    console.log(`\n\x1b[1mLoop ${loop}/${opts.loops}\x1b[0m`)

    // Docs writer
    const validTasks = previousResults.tasks.filter((t) => t.score >= 0)
    const judgeSuggestions = collectDocSuggestions(validTasks)
    const suggestionCount = judgeSuggestions.split('\n').filter(l => l.startsWith('-')).length

    events.send({ type: 'phase_change', phase: 'docs_writer', loop })
    events.send({ type: 'docs_writer', action: 'start', loop, suggestionCount })

    const docsSnapshotBefore = getDocsSnapshot(opts.repoPath)
    fs.writeFileSync(path.join(logDir, `judge-suggestions-loop-${loop}.txt`), judgeSuggestions)

    startSpinner(`Docs writer: processing ${suggestionCount} suggestions...`)
    await runDocsWriterAgent(opts.repoPath, judgeSuggestions, opts.docsModel)
    events.send({ type: 'docs_writer', action: 'complete', loop })
    stopSpinner(`  Docs writer: applied ${suggestionCount} suggestions`)

    // Save docs state and diff
    const docsAfterRefactor = getDocsSnapshot(opts.repoPath)
    const docsDiffText = computeDocsDiffText(docsSnapshotBefore, docsAfterRefactor)
    fs.writeFileSync(path.join(logDir, `docs-diff-loop-${loop}.txt`), docsDiffText)
    fs.writeFileSync(
      path.join(logDir, `docs-state-loop-${loop}.json`),
      JSON.stringify(docsAfterRefactor, null, 2),
    )

    // Re-eval with updated docs
    events.send({ type: 'phase_change', phase: 'evaluating', round: loop, loop, detail: 'Re-eval with updated docs' })
    const results = await runEvalRound(features, groundTruthDiffs, opts, loop, baseline.avgScore)
    saveRoundResults(logDir, results)

    totalCost += results.totalCost
    roundResults.push(results)
    previousResults = results

    // Re-judge baseline
    const rejudged = await runBaselineRejudgeRound(baseline, features, groundTruthDiffs, opts, loop)
    saveBaselineRejudgeResults(logDir, rejudged)
    baselineRejudgeResults.push(rejudged)

    // Collect project suggestions
    const loopProjectSuggestions = collectProjectSuggestions(results.tasks.filter(t => t.score >= 0))
    if (loopProjectSuggestions) allProjectSuggestionSections.push(`## Loop ${loop}\n\n${loopProjectSuggestions}`)
  }

  // --- Generate project improvement prompts ---
  let projectPrompts: string[] = []
  const allProjectSuggestionsText = allProjectSuggestionSections.join('\n\n')
  if (allProjectSuggestionsText.trim()) {
    fs.writeFileSync(path.join(logDir, 'project-suggestions-raw.txt'), allProjectSuggestionsText)
    startSpinner('Generating project improvement prompts...')
    projectPrompts = await runPromptWriterAgent(opts.repoPath, allProjectSuggestionsText, opts.docsModel)
    stopSpinner()
    if (projectPrompts.length > 0) {
      fs.writeFileSync(path.join(logDir, 'project-prompts.json'), JSON.stringify(projectPrompts, null, 2))
    }
  }

  // --- Final output ---
  const endTime = new Date().toISOString()

  const summary: EvalSummary = {
    repoPath: opts.repoPath,
    startTime,
    endTime,
    featuresCarved: features.length,
    rounds: roundResults.map((r) => ({
      round: r.round,
      avgScore: r.avgScore,
      scores: Object.fromEntries(r.tasks.map((t) => [t.featureId, t.score])),
      totalCost: r.totalCost,
    })),
    totalCost,
    scoreProgression: roundResults.map((r) => r.avgScore),
    baselineRejudgeProgression: baselineRejudgeResults.map((r) => r.avgScore),
    projectPrompts,
  }

  saveSummary(logDir, summary, roundResults, opts, baselineRejudgeResults, projectPrompts)

  events.send({
    type: 'run_complete',
    scoreProgression: summary.scoreProgression,
    totalCost,
    duration: `${startTime} → ${endTime}`,
  })
  events.close()

  // Print score table across all rounds
  printScoreTable(roundResults, baselineRejudgeResults)

  // Print project improvement prompts
  printProjectPrompts(projectPrompts)

  // Final summary line
  printFinalSummary({
    startTime,
    endTime,
    features: features.length,
    totalCost,
    scoreProgression: summary.scoreProgression,
    baselineRejudgeProgression: summary.baselineRejudgeProgression || [],
    promptCount: projectPrompts.length,
    logDir,
    reportPath: path.join(logDir, 'report.md'),
  })
}

// --- CLI entry point ---

if (import.meta.main) {
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
}
