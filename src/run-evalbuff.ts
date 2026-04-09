/**
 * Evalbuff — iterative documentation optimization through feature carving.
 *
 * Pipeline:
 *   1. Plan features to carve (GPT-5.4 via Codex SDK)
 *   2. Carve a random subset of n features
 *   3. Baseline: rebuild each feature sequentially (Claude Code), judge (Codex), get scores + suggestions
 *   4. Improvement round:
 *      a. Re-evaluate each feature sequentially
 *      b. Draft each suggested docs change independently
 *      c. Gate each docs change on the feature that inspired it before accepting it
 *
 * Usage:
 *   bun run src/run-evalbuff.ts --repo /path/to/repo [--n 5] [--init-command "npm install"]
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import { planFeatures, carveFeature } from './carve-features'
import {
  acceptDraftedDocsChange,
  cleanupDraftedDocsChange,
  cleanupPlannedDocsTaskResult,
  collectProjectSuggestions,
  collectTaskDocSuggestions,
  DEFAULT_DOC_SUGGESTION_PRIORITY_FLOOR,
  filterDocSuggestionsForPlanning,
  materializeDocsChangeFromPatch,
  planDocsChangesForTask,
  runPromptWriterAgent,
} from './docs-writer'
import { selectRandom, getGroundTruthDiff, getDocsSnapshot, computeDocsDiffText } from './eval-helpers'
import { runAgentOnCarve, rejudgeBaselineWithCurrentDocs, rejudgeTaskWithCurrentDocs } from './eval-runner'
import {
  startSpinner, updateSpinner, stopSpinner,
  printHeader, printRoundScores, printBaselineRejudge,
  printScoreTable, printProjectPrompts, printFinalSummary,
} from './log'
import { saveRoundResults, saveBaselineRejudgeResults, saveLoopDocGateArtifacts, saveLoopDocGateResults, saveSummary } from './report'
import { events } from './tui/events'

import type { CarvedFeature } from './carve-features'
import type { TaskResult } from './eval-runner'
import type {
  RoundResult,
  EvalSummary,
  DocChangeGateCandidateResult,
  FeatureDocGateResult,
  FeatureDocGateArtifacts,
  LoopDocGateResult,
} from './report'

// --- Types ---

export interface EvalbuffOptions {
  repoPath: string
  n: number            // number of features to randomly select
  initCommand?: string
  codingModel: string  // model for coding agents (default: sonnet)
  docsModel: string    // model for docs agents (default: opus)
  cachedFeatures?: string  // path to a features.json from a previous run
}

const DOC_CHANGE_ACCEPTANCE_THRESHOLD = 0.5
const DOC_CHANGE_FAST_ACCEPT_THRESHOLD = DOC_CHANGE_ACCEPTANCE_THRESHOLD * 2
const CARVE_PARALLELISM = 10

export function evaluateDocChangeGate(args: {
  baseScore: number
  rejudgeScore: number
  rerunScore?: number
  threshold?: number
  fastAcceptThreshold?: number
}): {
  accepted: boolean
  fastAccepted: boolean
  status: 'accepted' | 'accepted_fast_rejudge' | 'rejected'
  gateDelta: number
  reason: string
} {
  const threshold = args.threshold ?? DOC_CHANGE_ACCEPTANCE_THRESHOLD
  const fastAcceptThreshold = args.fastAcceptThreshold ?? DOC_CHANGE_FAST_ACCEPT_THRESHOLD
  const rejudgeDrop = args.baseScore - args.rejudgeScore

  if (rejudgeDrop >= fastAcceptThreshold) {
    return {
      accepted: true,
      fastAccepted: true,
      status: 'accepted_fast_rejudge',
      gateDelta: rejudgeDrop,
      reason: `Accepted without rerun because rejudge dropped by ${rejudgeDrop.toFixed(1)}.`,
    }
  }

  const gateDelta = (args.rerunScore ?? Number.NEGATIVE_INFINITY) - args.rejudgeScore
  if ((args.rerunScore ?? Number.NEGATIVE_INFINITY) - args.rejudgeScore >= threshold) {
    return {
      accepted: true,
      fastAccepted: false,
      status: 'accepted',
      gateDelta,
      reason: `Accepted because rerun minus rejudge was ${gateDelta.toFixed(1)}.`,
    }
  }

  return {
    accepted: false,
    fastAccepted: false,
    status: 'rejected',
    gateDelta,
    reason: `Rejected because rerun minus rejudge was ${gateDelta.toFixed(1)}.`,
  }
}

// --- Eval round ---

type EvalRoundDeps = {
  runAgentOnCarve: typeof runAgentOnCarve
  events: typeof events
  startSpinner: typeof startSpinner
  updateSpinner: typeof updateSpinner
  stopSpinner: typeof stopSpinner
  printRoundScores: typeof printRoundScores
}

const defaultEvalRoundDeps: EvalRoundDeps = {
  runAgentOnCarve,
  events,
  startSpinner,
  updateSpinner,
  stopSpinner,
  printRoundScores,
}

export async function runEvalRound(
  features: CarvedFeature[],
  groundTruthDiffs: Map<string, string>,
  opts: EvalbuffOptions,
  round: number,
  baselineAvg?: number,
  afterTask?: (args: {
    feature: CarvedFeature
    task: TaskResult
    index: number
  }) => Promise<number | void>,
  deps: EvalRoundDeps = defaultEvalRoundDeps,
): Promise<RoundResult> {
  const label = round === 0 ? 'Baseline' : `Round ${round}`
  const results: TaskResult[] = []

  deps.startSpinner(`${label}: evaluating 0/${features.length} features...`)

  for (let i = 0; i < features.length; i++) {
    const feature = features[i]
    try {
      deps.events.send({ type: 'feature_status', featureId: feature.id, status: 'agent_running' })
      const result = await deps.runAgentOnCarve({
        idx: i,
        total: features.length,
        repoPath: opts.repoPath,
        feature,
        initCommand: opts.initCommand,
        model: opts.codingModel,
        groundTruthDiff: groundTruthDiffs.get(feature.id) || '',
        docsSourcePath: opts.repoPath,
      })
      let additionalCost = 0
      if (afterTask) {
        try {
          additionalCost = (await afterTask({ feature, task: result, index: i })) ?? 0
        } catch (afterTaskError) {
          const msg = afterTaskError instanceof Error ? afterTaskError.message : String(afterTaskError)
          deps.events.log(`Docs gating failed for ${feature.id}: ${msg}`, 'error')
        }
      }
      result.costEstimate += additionalCost
      results[i] = result
      deps.events.send({ type: 'feature_status', featureId: feature.id, status: 'scored', score: result.score, cost: result.costEstimate })
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
        agentDocSuggestions: [],
        agentProjectSuggestions: [],
      }
      deps.events.send({ type: 'feature_status', featureId: feature.id, status: 'eval_failed', detail: msg.slice(0, 200) })
    }
    deps.updateSpinner(`${label}: ${i + 1}/${features.length} features evaluated`)
  }

  deps.stopSpinner()

  const valid = results.filter((r) => r.score >= 0)
  const avgScore = valid.length > 0
    ? valid.reduce((a, r) => a + r.score, 0) / valid.length
    : 0
  const totalCost = results.reduce((a, r) => a + r.costEstimate, 0)

  deps.printRoundScores(label, results, avgScore, totalCost, baselineAvg)

  deps.events.send({
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
// This lets us see whether the improvement round changed real agent behavior
// or merely judge calibration from better docs.

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
  for (let i = 0; i < baseline.tasks.length; i++) {
    const baselineTask = baseline.tasks[i]
    const feature = featureById.get(baselineTask.featureId)

    if (!feature || baselineTask.score < 0) {
      results[i] = baselineTask
      completed++
      updateSpinner(`Baseline rejudge: ${completed}/${baseline.tasks.length} re-scored`)
      continue
    }

    try {
      const judging = await rejudgeBaselineWithCurrentDocs({
        idx: i,
        total: baseline.tasks.length,
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
    updateSpinner(`Baseline rejudge: ${completed}/${baseline.tasks.length} re-scored`)
  }

  stopSpinner()

  const valid = results.filter((r) => r.score >= 0)
  const avgScore = valid.length > 0
    ? valid.reduce((a, r) => a + r.score, 0) / valid.length
    : 0

  printBaselineRejudge(avgScore, baseline.avgScore)

  return { round: loop, tasks: results, avgScore, totalCost: 0 }
}

function renderLoopDocGateSummary(loopResult: LoopDocGateResult): string {
  const lines: string[] = []

  for (const feature of loopResult.features) {
    if (feature.candidates.length === 0) continue
    lines.push(`### ${feature.featureId} (base score: ${feature.baseScore.toFixed(1)}/10)`)
    for (const candidate of feature.candidates) {
      const scores = [
        `base ${candidate.baseScore.toFixed(1)}`,
        candidate.rejudgeScore !== undefined ? `rejudge ${candidate.rejudgeScore.toFixed(1)}` : null,
        candidate.rerunScore !== undefined ? `rerun ${candidate.rerunScore.toFixed(1)}` : null,
      ].filter(Boolean).join(' -> ')
      const gateDelta = candidate.gateDelta !== undefined
        ? ` gate ${candidate.gateDelta >= 0 ? '+' : ''}${candidate.gateDelta.toFixed(1)}`
        : ''
      lines.push(
        `- [${candidate.status}] [${candidate.source}] [priority ${candidate.priority}] ${candidate.text}`,
      )
      lines.push(`  ${scores}${gateDelta}`)
      lines.push(`  ${candidate.reason}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

function countLoopDocChanges(loopResult: LoopDocGateResult): {
  considered: number
  accepted: number
} {
  let considered = 0
  let accepted = 0
  for (const feature of loopResult.features) {
    for (const candidate of feature.candidates) {
      considered++
      if (candidate.accepted) accepted++
    }
  }
  return { considered, accepted }
}

type GateDocsChangesDeps = {
  collectTaskDocSuggestions: typeof collectTaskDocSuggestions
  filterDocSuggestionsForPlanning: typeof filterDocSuggestionsForPlanning
  planDocsChangesForTask: typeof planDocsChangesForTask
  materializeDocsChangeFromPatch: typeof materializeDocsChangeFromPatch
  cleanupDraftedDocsChange: typeof cleanupDraftedDocsChange
  acceptDraftedDocsChange: typeof acceptDraftedDocsChange
  cleanupPlannedDocsTaskResult: typeof cleanupPlannedDocsTaskResult
  rejudgeTaskWithCurrentDocs: typeof rejudgeTaskWithCurrentDocs
  runAgentOnCarve: typeof runAgentOnCarve
  events: typeof events
}

const defaultGateDocsChangesDeps: GateDocsChangesDeps = {
  collectTaskDocSuggestions,
  filterDocSuggestionsForPlanning,
  planDocsChangesForTask,
  materializeDocsChangeFromPatch,
  cleanupDraftedDocsChange,
  acceptDraftedDocsChange,
  cleanupPlannedDocsTaskResult,
  rejudgeTaskWithCurrentDocs,
  runAgentOnCarve,
  events,
}

export async function gateDocsChangesForTask(args: {
  feature: CarvedFeature
  task: TaskResult
  opts: EvalbuffOptions
  groundTruthDiffs: Map<string, string>
  loop: number
}, deps: GateDocsChangesDeps = defaultGateDocsChangesDeps): Promise<{
  result: FeatureDocGateResult
  artifacts: FeatureDocGateArtifacts
  validationCost: number
}> {
  const allSuggestions = deps.collectTaskDocSuggestions(args.task)
  const suggestions = deps.filterDocSuggestionsForPlanning(allSuggestions)
  const gatedCandidates: DocChangeGateCandidateResult[] = []
  const gateArtifacts: FeatureDocGateArtifacts = {
    featureId: args.feature.id,
    candidates: [],
  }
  let validationCost = 0
  let enteredDocsWriterPhase = false

  function recordCandidate(
    candidate: DocChangeGateCandidateResult,
    artifacts: Omit<FeatureDocGateArtifacts['candidates'][number], 'summary'> = {},
  ): void {
    gatedCandidates.push(candidate)
    gateArtifacts.candidates.push({
      summary: candidate,
      ...artifacts,
    })
  }

  if (allSuggestions.length === 0 || args.task.score < 0) {
    return {
      result: {
        featureId: args.feature.id,
        baseScore: args.task.score,
        candidates: [],
      },
      artifacts: gateArtifacts,
      validationCost,
    }
  }

  deps.events.send({
    type: 'phase_change',
    phase: 'docs_writer',
    round: args.loop,
    loop: args.loop,
    detail: `${args.feature.id}: ${allSuggestions.length} candidate doc changes`,
  })
  deps.events.send({
    type: 'docs_writer',
    action: 'start',
    loop: args.loop,
    suggestionCount: allSuggestions.length,
  })
  enteredDocsWriterPhase = true
  let plan: Awaited<ReturnType<typeof planDocsChangesForTask>> | null = null
  try {
    for (const skipped of allSuggestions.filter((suggestion) => suggestion.priority < DEFAULT_DOC_SUGGESTION_PRIORITY_FLOOR)) {
      recordCandidate({
        source: skipped.source,
        priority: skipped.priority,
        text: skipped.text,
        accepted: false,
        fastAccepted: false,
        status: 'skipped_low_priority',
        reason: `Skipped before docs writing because priority ${skipped.priority} is below ${DEFAULT_DOC_SUGGESTION_PRIORITY_FLOOR}.`,
        baseScore: args.task.score,
        docsDiff: '',
      })
    }

    if (suggestions.length === 0) {
      return {
        result: {
          featureId: args.feature.id,
          baseScore: args.task.score,
          candidates: gatedCandidates,
        },
        artifacts: gateArtifacts,
        validationCost,
      }
    }

    plan = await deps.planDocsChangesForTask(
      args.opts.repoPath,
      suggestions,
      args.opts.docsModel,
      DEFAULT_DOC_SUGGESTION_PRIORITY_FLOOR,
    )
    if (!plan) {
      for (const suggestion of suggestions) {
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: false,
          fastAccepted: false,
          status: 'rejected_writer_failed',
          reason: 'Docs writer failed to produce a candidate plan.',
          baseScore: args.task.score,
          docsDiff: '',
        })
      }
      return {
        result: {
          featureId: args.feature.id,
          baseScore: args.task.score,
          candidates: gatedCandidates,
        },
        artifacts: gateArtifacts,
        validationCost,
      }
    }

    for (const suggestion of plan.candidates) {
      if (!suggestion.accepted) {
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: false,
          fastAccepted: false,
          status: suggestion.overfit ? 'rejected_overfit' : 'rejected',
          reason: suggestion.reason,
          baseScore: args.task.score,
          docsDiff: suggestion.diffText || '',
        }, {
          docsPatchText: suggestion.patchText,
        })
        continue
      }

      if (!suggestion.patchText) {
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: false,
          fastAccepted: false,
          status: 'rejected_no_change',
          reason: `Rejected because the planned docs change had no reusable patch: ${suggestion.reason}`,
          baseScore: args.task.score,
          docsDiff: suggestion.diffText || '',
        })
        continue
      }

      const draft = deps.materializeDocsChangeFromPatch(args.opts.repoPath, suggestion.patchText)
      if (!draft) {
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: false,
          fastAccepted: false,
          status: 'rejected_writer_failed',
          reason: `Failed to materialize docs change: ${suggestion.reason}`,
          baseScore: args.task.score,
          docsDiff: suggestion.diffText || '',
        }, {
          docsPatchText: suggestion.patchText,
        })
        continue
      }

      if (!draft.diffText.trim()) {
        deps.cleanupDraftedDocsChange(draft)
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: false,
          fastAccepted: false,
          status: 'rejected_no_change',
          reason: 'The planned docs change produced no effective diff when applied to the current docs.',
          baseScore: args.task.score,
          docsDiff: draft.diffText,
        }, {
          docsPatchText: suggestion.patchText,
        })
        continue
      }

      let rejudgeScore: number | undefined
      let rejudgeJudging: Awaited<ReturnType<typeof rejudgeTaskWithCurrentDocs>> | undefined
      try {
        const rejudged = await deps.rejudgeTaskWithCurrentDocs({
          idx: 0,
          total: 1,
          repoPath: args.opts.repoPath,
          feature: args.feature,
          agentDiff: args.task.diff,
          groundTruthDiff: args.groundTruthDiffs.get(args.feature.id) || '',
          initCommand: args.opts.initCommand,
          docsSourcePath: draft.repoDir,
        })
        rejudgeJudging = rejudged
        rejudgeScore = rejudged.overallScore
      } catch (error) {
        deps.cleanupDraftedDocsChange(draft)
        const msg = error instanceof Error ? error.message : String(error)
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: false,
          fastAccepted: false,
          status: 'rejected_rejudge_failed',
          reason: `Rejudge failed: ${msg.slice(0, 200)}`,
          baseScore: args.task.score,
          docsDiff: draft.diffText,
        }, {
          docsPatchText: suggestion.patchText,
        })
        continue
      }

      if (rejudgeScore === undefined) {
        deps.cleanupDraftedDocsChange(draft)
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: false,
          fastAccepted: false,
          status: 'rejected_rejudge_failed',
          reason: 'Rejudge did not produce a score.',
          baseScore: args.task.score,
          docsDiff: draft.diffText,
        }, {
          docsPatchText: suggestion.patchText,
        })
        continue
      }

      const fastDecision = evaluateDocChangeGate({
        baseScore: args.task.score,
        rejudgeScore,
      })
      if (fastDecision.accepted && fastDecision.fastAccepted) {
        deps.acceptDraftedDocsChange(args.opts.repoPath, draft)
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: fastDecision.accepted,
          fastAccepted: fastDecision.fastAccepted,
          status: fastDecision.status,
          reason: `${suggestion.reason} ${fastDecision.reason}`.trim(),
          baseScore: args.task.score,
          rejudgeScore,
          gateDelta: fastDecision.gateDelta,
          docsDiff: draft.diffText,
        }, {
          docsPatchText: suggestion.patchText,
          rejudgeJudging,
        })
        continue
      }

      const rerunTask = await deps.runAgentOnCarve({
        idx: 0,
        total: 1,
        repoPath: args.opts.repoPath,
        feature: args.feature,
        initCommand: args.opts.initCommand,
        model: args.opts.codingModel,
        groundTruthDiff: args.groundTruthDiffs.get(args.feature.id) || '',
        docsSourcePath: draft.repoDir,
      })
      validationCost += rerunTask.costEstimate

      const decision = evaluateDocChangeGate({
        baseScore: args.task.score,
        rejudgeScore,
        rerunScore: rerunTask.score,
      })
      if (rerunTask.score >= 0 && decision.accepted) {
        deps.acceptDraftedDocsChange(args.opts.repoPath, draft)
        recordCandidate({
          source: suggestion.source,
          priority: suggestion.priority,
          text: suggestion.text,
          accepted: decision.accepted,
          fastAccepted: decision.fastAccepted,
          status: decision.status,
          reason: `${suggestion.reason} ${decision.reason}`.trim(),
          baseScore: args.task.score,
          rejudgeScore,
          rerunScore: rerunTask.score,
          gateDelta: decision.gateDelta,
          docsDiff: draft.diffText,
        }, {
          docsPatchText: suggestion.patchText,
          rejudgeJudging,
          rerunTask,
        })
        continue
      }

      deps.cleanupDraftedDocsChange(draft)
      recordCandidate({
        source: suggestion.source,
        priority: suggestion.priority,
        text: suggestion.text,
        accepted: false,
        fastAccepted: false,
        status: rerunTask.score < 0 ? 'rejected_rerun_failed' : 'rejected',
        reason: rerunTask.score < 0
          ? `Rejected because the validation rerun failed. ${suggestion.reason}`.trim()
          : `${suggestion.reason} ${decision.reason}`.trim(),
        baseScore: args.task.score,
        rejudgeScore,
        rerunScore: rerunTask.score,
        gateDelta: decision.gateDelta,
        docsDiff: draft.diffText,
      }, {
        docsPatchText: suggestion.patchText,
        rejudgeJudging,
        rerunTask,
      })
    }

    return {
      result: {
        featureId: args.feature.id,
        baseScore: args.task.score,
        candidates: gatedCandidates,
      },
      artifacts: gateArtifacts,
      validationCost,
    }
  } finally {
    if (plan) {
      deps.cleanupPlannedDocsTaskResult(plan)
    }
    if (enteredDocsWriterPhase) {
      deps.events.send({ type: 'docs_writer', action: 'complete', loop: args.loop })
      deps.events.send({
        type: 'phase_change',
        phase: 'evaluating',
        round: args.loop,
        loop: args.loop,
        detail: 'Re-eval with updated docs',
      })
    }
  }
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
    codingModel: opts.codingModel,
    docsModel: opts.docsModel,
    logDir,
  })

  printHeader({
    repoPath: opts.repoPath,
    n: opts.n,
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
      const carveResults: (CarvedFeature | null)[] = new Array(carveQueue.length).fill(null)

      startSpinner(`Carving 0/${carveQueue.length} features...`)
      let carveCompleted = 0

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
        Array.from({ length: Math.min(CARVE_PARALLELISM, carveQueue.length) }, () => carveWorker()),
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
  const loopDocGateResults: LoopDocGateResult[] = []
  const allProjectSuggestionSections: string[] = []

  // Collect project suggestions from baseline
  const baselineProjectSuggestions = collectProjectSuggestions(baseline.tasks.filter(t => t.score >= 0))
  if (baselineProjectSuggestions) allProjectSuggestionSections.push(`## Baseline Round\n\n${baselineProjectSuggestions}`)

  // --- Improvement round ---
  const improvementRound = 1
  console.log(`\n\x1b[1mImprovement Round\x1b[0m`)

  const docsSnapshotBefore = getDocsSnapshot(opts.repoPath)
  events.send({ type: 'phase_change', phase: 'evaluating', round: improvementRound, loop: improvementRound, detail: 'Re-eval with updated docs' })
  const featureGateResults: FeatureDocGateResult[] = []
  const featureGateArtifacts: FeatureDocGateArtifacts[] = []
  const results = await runEvalRound(
    features,
    groundTruthDiffs,
    opts,
    improvementRound,
    baseline.avgScore,
    async ({ feature, task }) => {
      const gated = await gateDocsChangesForTask({
        feature,
        task,
        opts,
        groundTruthDiffs,
        loop: improvementRound,
      })
      featureGateResults.push(gated.result)
      featureGateArtifacts.push(gated.artifacts)
      return gated.validationCost
    },
  )

  totalCost += results.totalCost
  roundResults.push(results)

  const loopDocGateResult: LoopDocGateResult = {
    loop: improvementRound,
    threshold: DOC_CHANGE_ACCEPTANCE_THRESHOLD,
    fastAcceptThreshold: DOC_CHANGE_FAST_ACCEPT_THRESHOLD,
    features: featureGateResults,
  }
  loopDocGateResults.push(loopDocGateResult)

  const docsAfterRefactor = getDocsSnapshot(opts.repoPath)
  const docsDiffText = computeDocsDiffText(docsSnapshotBefore, docsAfterRefactor)
  const loopSummaryText = renderLoopDocGateSummary(loopDocGateResult)
  fs.writeFileSync(path.join(logDir, `judge-suggestions-loop-${improvementRound}.txt`), loopSummaryText)
  fs.writeFileSync(path.join(logDir, `docs-diff-loop-${improvementRound}.txt`), docsDiffText)
  fs.writeFileSync(
    path.join(logDir, `docs-state-loop-${improvementRound}.json`),
    JSON.stringify(docsAfterRefactor, null, 2),
  )
  saveLoopDocGateResults(logDir, loopDocGateResult)
  saveLoopDocGateArtifacts(logDir, improvementRound, featureGateArtifacts)
  saveRoundResults(logDir, results)

  const rejudged = await runBaselineRejudgeRound(baseline, features, groundTruthDiffs, opts, improvementRound)
  saveBaselineRejudgeResults(logDir, rejudged)
  baselineRejudgeResults.push(rejudged)

  const loopProjectSuggestions = collectProjectSuggestions(results.tasks.filter(t => t.score >= 0))
  if (loopProjectSuggestions) allProjectSuggestionSections.push(`## Improvement Round\n\n${loopProjectSuggestions}`)

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
    consideredDocChangesByLoop: loopDocGateResults.map((result) => countLoopDocChanges(result).considered),
    acceptedDocChangesByLoop: loopDocGateResults.map((result) => countLoopDocChanges(result).accepted),
    projectPrompts,
  }

  saveSummary(logDir, summary, roundResults, opts, baselineRejudgeResults, loopDocGateResults, projectPrompts)

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
  const initCommand = hasArg('init-command') ? getArg('init-command') : undefined
  const codingModel = getArg('coding-model', 'sonnet')
  const docsModel = getArg('docs-model', 'opus')
  const cachedFeatures = hasArg('cached-features') ? getArg('cached-features') : undefined

  runEvalbuff({
    repoPath,
    n,
    initCommand,
    codingModel,
    docsModel,
    cachedFeatures,
  }).catch((error) => {
    console.error('Evalbuff run failed:', error)
    process.exit(1)
  })
}
