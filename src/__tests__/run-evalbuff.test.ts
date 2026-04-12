import { afterEach, describe, expect, it } from 'bun:test'

import { evaluateDocChangeGate, gateDocsChangesForTask, runEvalRound } from '../run-evalbuff'
import { events } from '../tui/events'

import type { CarvedFeature } from '../carve-features'
import type { TaskResult } from '../eval-runner'

function createTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    featureId: 'feature-a',
    prompt: 'Restore feature a',
    score: 6,
    diff: 'diff --git a/file.ts b/file.ts\n',
    trace: '',
    judging: {
      analysis: 'ok',
      strengths: [],
      weaknesses: [],
      e2eTestsPerformed: [],
      completionScore: 6,
      codeQualityScore: 6,
      e2eScore: 6,
      overallScore: 6,
      docSuggestions: [],
      projectSuggestions: [],
    },
    costEstimate: 0,
    docsRead: [],
    agentDocSuggestions: [],
    agentProjectSuggestions: [],
    ...overrides,
  }
}

function createFeature(): CarvedFeature {
  return {
    id: 'feature-a',
    prompt: 'Restore feature a',
    description: 'Test feature',
    complexity: 'small',
    originalFiles: {},
    operations: [],
    diff: 'diff --git a/file.ts b/file.ts\n',
  }
}

describe('evaluateDocChangeGate', () => {
  afterEach(() => {
    events.close()
    events.clearBuffer()
  })

  it('accepts when rerun minus rejudge clears the threshold', () => {
    const result = evaluateDocChangeGate({
      baseScore: 6,
      rejudgeScore: 5.8,
      rerunScore: 6.4,
    })

    expect(result.accepted).toBe(true)
    expect(result.status).toBe('accepted')
    expect(result.gateDelta).toBeCloseTo(0.6, 6)
    expect(result.reason).toBe('Accepted because rerun minus rejudge was 0.6.')
  })

  it('rejects when rerun minus rejudge stays below the threshold', () => {
    const result = evaluateDocChangeGate({
      baseScore: 6,
      rejudgeScore: 5.8,
      rerunScore: 6.1,
    })

    expect(result.accepted).toBe(false)
    expect(result.status).toBe('rejected')
    expect(result.gateDelta).toBeCloseTo(0.3, 6)
    expect(result.reason).toBe('Rejected because rerun minus rejudge was 0.3.')
  })

  it('adds validation rerun cost into round totals', async () => {
    const feature = createFeature()

    const round = await runEvalRound(
      [feature],
      new Map([[feature.id, feature.diff]]),
      {
        repoPath: '/tmp/repo',
        n: 1,
        codingModel: 'sonnet',
        docsModel: 'opus',
      },
      1,
      undefined,
      async () => 3,
      {
        runAgentOnCarve: async () => createTaskResult({ costEstimate: 2 }),
        events,
        startSpinner: () => {},
        updateSpinner: () => {},
        stopSpinner: () => {},
        printRoundScores: () => {},
      },
    )

    expect(round.tasks[0]?.costEstimate).toBe(5)
    expect(round.totalCost).toBe(5)
  })

  it('returns docs gate rerun cost and restores the evaluating phase after docs gating', async () => {
    const feature = createFeature()
    const task = createTaskResult({
      agentDocSuggestions: [{ text: 'Document the rerun gate', priority: 80 }],
    })

    const gated = await gateDocsChangesForTask(
      {
        feature,
        task,
        opts: {
          repoPath: '/tmp/repo',
          n: 1,
          codingModel: 'sonnet',
          docsModel: 'opus',
        },
        groundTruthDiffs: new Map([[feature.id, feature.diff]]),
        loop: 1,
      },
      {
        collectTaskDocSuggestions: (inputTask) => inputTask.agentDocSuggestions.map((suggestion) => ({
          ...suggestion,
          source: 'agent' as const,
        })),
        filterDocSuggestionsForPlanning: (suggestions) => suggestions,
        planDocsChangesForTask: async () => ({
          tempDir: '/tmp/docs-plan',
          repoDir: '/tmp/docs-plan/repo',
          baseCommit: 'base',
          candidates: [
            {
              accepted: true,
              source: 'agent' as const,
              priority: 80,
              text: 'Document the rerun gate',
              reason: 'Useful guidance',
              overfit: false,
              fileChanges: [
                { path: 'docs/guide.md', content: '# Guide\nRerun gate.\n' },
              ],
              diffText: '--- a/docs/guide.md\n+++ b/docs/guide.md\n',
            },
          ],
        }),
        materializeDocsChange: () => ({
          tempDir: '/tmp/draft-docs',
          repoDir: '/tmp/draft-docs',
          before: {},
          after: {},
          diffText: '--- a/docs/guide.md\n+++ b/docs/guide.md\n',
        }),
        cleanupDraftedDocsChange: () => {},
        acceptDraftedDocsChange: () => [],
        cleanupPlannedDocsTaskResult: () => {},
        rejudgeTaskWithCurrentDocs: async () => ({
          analysis: 'rejudge',
          strengths: [],
          weaknesses: [],
          e2eTestsPerformed: [],
          completionScore: 5.8,
          codeQualityScore: 5.8,
          e2eScore: 5.8,
          overallScore: 5.8,
        }),
        runAgentOnCarve: async () => createTaskResult({
          score: 6.4,
          costEstimate: 3,
          judging: {
            analysis: 'rerun',
            strengths: [],
            weaknesses: [],
            e2eTestsPerformed: [],
            completionScore: 6.4,
            codeQualityScore: 6.4,
            e2eScore: 6.4,
            overallScore: 6.4,
            docSuggestions: [],
            projectSuggestions: [],
          },
        }),
        events,
      },
    )

    expect(gated.validationCost).toBe(3)
    expect(gated.result.candidates[0]?.rerunScore).toBe(6.4)

    const phaseChanges: Array<{ phase: string; round?: number; loop?: number }> = []
    events.replay(({ event }) => {
      if (event.type === 'phase_change') {
        phaseChanges.push({ phase: event.phase, round: event.round, loop: event.loop })
      }
    })

    expect(phaseChanges).toContainEqual({
      phase: 'docs_writer',
      round: 1,
      loop: 1,
    })
    expect(phaseChanges).toContainEqual({
      phase: 'evaluating',
      round: 1,
      loop: 1,
    })
  })
})
