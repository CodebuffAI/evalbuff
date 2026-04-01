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
import { collectDocSuggestions, runDocsRefactorAgent } from './docs-refactor'
import { selectRandom, getGroundTruthDiff, getDocsSnapshot, computeDocsDiffText } from './eval-helpers'
import { runAgentOnCarve } from './eval-runner'
import { saveRoundResults, saveSummary } from './report'

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
}

// --- Eval round ---

async function runEvalRound(
  features: CarvedFeature[],
  groundTruthDiffs: Map<string, string>,
  opts: EvalbuffOptions,
  round: number,
): Promise<RoundResult> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`ROUND ${round} — Evaluating ${features.length} features (parallelism=${opts.parallelism})`)
  console.log(`${'='.repeat(60)}`)

  // Run features with bounded concurrency
  const results: TaskResult[] = []
  const queue = features.map((feature, i) => ({ feature, i }))
  let next = 0

  async function worker(): Promise<void> {
    while (next < queue.length) {
      const { feature, i } = queue[next++]
      try {
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
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opts.parallelism, features.length) }, () => worker()),
  )

  const valid = results.filter((r) => r.score >= 0)
  const avgScore = valid.length > 0
    ? valid.reduce((a, r) => a + r.score, 0) / valid.length
    : 0
  const totalCost = results.reduce((a, r) => a + r.costEstimate, 0)

  console.log(`\nRound ${round} results:`)
  for (const r of results) {
    const status = r.score >= 0 ? `${r.score.toFixed(1)}/10` : 'FAILED'
    console.log(`  ${r.featureId}: ${status}`)
  }
  console.log(`  Average: ${avgScore.toFixed(1)}/10 (${valid.length}/${results.length} succeeded)`)
  console.log(`  Cost: $${totalCost.toFixed(2)}`)

  return { round, tasks: results, avgScore, totalCost }
}

// --- Main orchestrator ---

export async function runEvalbuff(opts: EvalbuffOptions): Promise<void> {
  const startTime = new Date().toISOString()
  const logDir = path.join(os.tmpdir(), `evalbuff-run-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`)
  fs.mkdirSync(logDir, { recursive: true })

  console.log(`\nEvalbuff Run`)
  console.log(`  Repo: ${opts.repoPath}`)
  console.log(`  Features to carve: ${opts.n}`)
  console.log(`  Improvement loops: ${opts.loops}`)
  console.log(`  Coding model: ${opts.codingModel}`)
  console.log(`  Docs model: ${opts.docsModel}`)
  console.log(`  Log dir: ${logDir}`)

  // --- Step 1: Plan features ---
  console.log(`\n${'='.repeat(60)}`)
  console.log('STEP 1: Planning features to carve...')
  console.log(`${'='.repeat(60)}`)

  const plan = await planFeatures(opts.repoPath)
  console.log(`\nIdentified ${plan.candidates.length} candidates. Reasoning:\n${plan.reasoning.slice(0, 500)}`)

  fs.writeFileSync(path.join(logDir, 'plan.json'), JSON.stringify(plan, null, 2))

  // --- Step 2: Select random subset and carve ---
  console.log(`\n${'='.repeat(60)}`)
  console.log(`STEP 2: Selecting ${opts.n} random features and carving...`)
  console.log(`${'='.repeat(60)}`)

  const selected = selectRandom(plan.candidates, opts.n)
  console.log(`Selected: ${selected.map((c) => c.id).join(', ')}`)

  const features: CarvedFeature[] = []
  {
    // Carve features in parallel with bounded concurrency
    const carveQueue = [...selected]
    let carveNext = 0
    const carveResults: (CarvedFeature | null)[] = new Array(carveQueue.length).fill(null)

    async function carveWorker(): Promise<void> {
      while (carveNext < carveQueue.length) {
        const idx = carveNext++
        const candidate = carveQueue[idx]
        try {
          const carved = await carveFeature(opts.repoPath, candidate)
          if (carved) {
            carveResults[idx] = carved
            console.log(`  Carved: ${carved.id} — ${carved.operations.length} file operations`)
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`  Failed to carve ${candidate.id}: ${msg.slice(0, 200)}`)
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(opts.parallelism, carveQueue.length) }, () => carveWorker()),
    )
    for (const result of carveResults) {
      if (result) features.push(result)
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

  // --- Step 3: Baseline evaluation ---
  console.log(`\n${'='.repeat(60)}`)
  console.log('STEP 3: Baseline evaluation')
  console.log(`${'='.repeat(60)}`)

  const baseline = await runEvalRound(features, groundTruthDiffs, opts, 0)
  saveRoundResults(logDir, baseline)

  let totalCost = baseline.totalCost
  const roundResults: RoundResult[] = [baseline]
  let previousResults = baseline

  // --- Step 4: Improvement loops ---
  for (let loop = 1; loop <= opts.loops; loop++) {
    console.log(`\n${'*'.repeat(60)}`)
    console.log(`IMPROVEMENT LOOP ${loop}/${opts.loops}`)
    console.log(`${'*'.repeat(60)}`)

    // 4a: Collect judge suggestions and run docs refactor agent
    const validTasks = previousResults.tasks.filter((t) => t.score >= 0)
    const judgeSuggestions = collectDocSuggestions(validTasks)

    console.log(`\n--- Step 4a: Docs refactor with judge suggestions ---`)
    const docsSnapshotBefore = getDocsSnapshot(opts.repoPath)

    fs.writeFileSync(path.join(logDir, `judge-suggestions-loop-${loop}.txt`), judgeSuggestions)

    await runDocsRefactorAgent(opts.repoPath, judgeSuggestions, opts.docsModel)

    // Save docs state and diff for this loop
    const docsAfterRefactor = getDocsSnapshot(opts.repoPath)
    const docsDiffText = computeDocsDiffText(docsSnapshotBefore, docsAfterRefactor)
    fs.writeFileSync(path.join(logDir, `docs-diff-loop-${loop}.txt`), docsDiffText)
    fs.writeFileSync(
      path.join(logDir, `docs-state-loop-${loop}.json`),
      JSON.stringify(docsAfterRefactor, null, 2),
    )

    // 4b: Re-eval with updated docs
    console.log(`\n--- Step 4b: Re-evaluation with updated docs ---`)
    const results = await runEvalRound(features, groundTruthDiffs, opts, loop)
    saveRoundResults(logDir, results)

    totalCost += results.totalCost
    roundResults.push(results)
    previousResults = results

    console.log(`\n  Loop ${loop} complete. Score: ${baseline.avgScore.toFixed(1)} → ${results.avgScore.toFixed(1)}`)
  }

  // --- Summary ---
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
  }

  saveSummary(logDir, summary, roundResults, opts)

  console.log(`\n${'='.repeat(60)}`)
  console.log('EVALBUFF RUN COMPLETE')
  console.log(`${'='.repeat(60)}`)
  console.log(`  Duration: ${startTime} → ${endTime}`)
  console.log(`  Features: ${features.length}`)
  console.log(`  Total cost: $${totalCost.toFixed(2)}`)
  console.log(`  Score progression: ${summary.scoreProgression.map((s) => s.toFixed(1)).join(' → ')}`)
  console.log(`  Logs: ${logDir}`)
  console.log(`  Report: ${path.join(logDir, 'report.md')}`)
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
  const n = parseInt(getArg('n', '5'))
  const parallelism = parseInt(getArg('parallelism', '10'))
  const loops = parseInt(getArg('loops', '3'))
  const initCommand = hasArg('init-command') ? getArg('init-command') : undefined
  const codingModel = getArg('coding-model', 'sonnet')
  const docsModel = getArg('docs-model', 'opus')

  runEvalbuff({
    repoPath,
    n,
    parallelism,
    loops,
    initCommand,
    codingModel,
    docsModel,
  }).catch((error) => {
    console.error('Evalbuff run failed:', error)
    process.exit(1)
  })
}
