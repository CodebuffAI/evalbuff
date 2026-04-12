import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, it } from 'bun:test'

import { roundLabel, saveLoopDocGateArtifacts } from '../report'

import type { FeatureDocGateArtifacts } from '../report'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('roundLabel', () => {
  it('labels round 0 as Baseline regardless of total rounds', () => {
    expect(roundLabel(0, 1)).toBe('Baseline')
    expect(roundLabel(0, 2)).toBe('Baseline')
    expect(roundLabel(0, 3)).toBe('Baseline')
  })

  it('labels intermediate rounds as Loop N', () => {
    expect(roundLabel(1, 3)).toBe('Loop 1')
    expect(roundLabel(2, 4)).toBe('Loop 2')
  })

  it('labels the last round as Final when there are at least 3 rounds', () => {
    expect(roundLabel(2, 3)).toBe('Final')
    expect(roundLabel(3, 4)).toBe('Final')
  })

  it('still labels the last improvement round as Loop N when no Final round was run', () => {
    expect(roundLabel(1, 2)).toBe('Loop 1')
  })
})

describe('saveLoopDocGateArtifacts', () => {
  it('persists per-candidate docs diffs, rejudge output, and rerun artifacts', () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-report-test-'))
    tempDirs.push(logDir)

    const artifacts: FeatureDocGateArtifacts[] = [
      {
        featureId: 'feature-a',
        candidates: [
          {
            summary: {
              source: 'judge',
              priority: 80,
              text: 'Document env setup for config-sensitive tests',
              accepted: true,
              status: 'accepted',
              reason: 'Reusable and verified',
              baseScore: 6,
              rejudgeScore: 5.5,
              rerunScore: 6.4,
              gateDelta: 0.9,
              docsDiff: '--- a/docs/testing.md\n+++ b/docs/testing.md\n+Set APP_MODE=test\n',
            },
            rejudgeJudging: {
              analysis: 'More discerning with updated docs.',
              strengths: [],
              weaknesses: [],
              e2eTestsPerformed: [],
              completionScore: 5.5,
              codeQualityScore: 5.5,
              e2eScore: 5.5,
              overallScore: 5.5,
            },
            rerunTask: {
              featureId: 'feature-a',
              prompt: 'Restore feature a',
              score: 6.4,
              diff: 'diff --git a/src/a.ts b/src/a.ts\n',
              trace: '{"type":"text","text":"rerun trace"}\n',
              judging: {
                analysis: 'Improved rerun.',
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
              costEstimate: 1.25,
              docsRead: ['docs/testing.md'],
              agentDocSuggestions: [{ text: 'Keep env setup docs', priority: 40 }],
              agentProjectSuggestions: [{ text: 'Add config helper', priority: 30 }],
            },
          },
        ],
      },
    ]

    saveLoopDocGateArtifacts(logDir, 1, artifacts)

    const candidateDir = path.join(logDir, 'doc-candidates-loop-1', 'feature-a', 'candidate-01')
    expect(fs.existsSync(candidateDir)).toBe(true)
    expect(fs.readFileSync(path.join(candidateDir, 'suggestion.txt'), 'utf-8')).toContain('Document env setup')
    expect(fs.existsSync(path.join(candidateDir, 'docs.patch'))).toBe(false)
    expect(fs.readFileSync(path.join(candidateDir, 'docs-diff.txt'), 'utf-8')).toContain('APP_MODE=test')

    const metadata = JSON.parse(fs.readFileSync(path.join(candidateDir, 'metadata.json'), 'utf-8'))
    expect(metadata.rejudgeScore).toBe(5.5)
    expect(metadata.rerunScore).toBe(6.4)

    const rejudge = JSON.parse(fs.readFileSync(path.join(candidateDir, 'rejudge.json'), 'utf-8'))
    expect(rejudge.overallScore).toBe(5.5)

    expect(fs.readFileSync(path.join(candidateDir, 'rerun-trace.txt'), 'utf-8')).toContain('rerun trace')
    expect(fs.readFileSync(path.join(candidateDir, 'rerun-diff.txt'), 'utf-8')).toContain('src/a.ts')

    const rerunJudging = JSON.parse(fs.readFileSync(path.join(candidateDir, 'rerun-judging.json'), 'utf-8'))
    expect(rerunJudging.overallScore).toBe(6.4)

    const rerunSuggestions = JSON.parse(
      fs.readFileSync(path.join(candidateDir, 'rerun-agent-suggestions.json'), 'utf-8'),
    )
    expect(rerunSuggestions.docSuggestions[0]?.text).toBe('Keep env setup docs')
    expect(fs.readFileSync(path.join(candidateDir, 'rerun-score.txt'), 'utf-8').trim()).toBe('6.4')
  })
})
