import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, it } from 'bun:test'

import {
  CODING_AGENT_SUGGESTIONS_FILE,
  collectTaskDocSuggestions,
  filterDocSuggestionsForPlanning,
  readCodingAgentSuggestions,
} from '../docs-writer'

describe('docs-writer helpers', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const tempPath of tempPaths.splice(0)) {
      try {
        fs.rmSync(tempPath, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures
      }
    }
  })

  it('merges judge and coding-agent doc suggestions by text', () => {
    const merged = collectTaskDocSuggestions({
      featureId: 'feature-a',
      prompt: 'restore feature a',
      score: 5,
      diff: '',
      trace: '',
      judging: {
        analysis: '',
        strengths: [],
        weaknesses: [],
        e2eTestsPerformed: [],
        completionScore: 5,
        codeQualityScore: 5,
        e2eScore: 5,
        overallScore: 5,
        docSuggestions: [
          { text: 'Document the setup script', priority: 60 },
          { text: 'Describe the test harness', priority: 40 },
        ],
        projectSuggestions: [],
      },
      costEstimate: 0,
      docsRead: [],
      agentDocSuggestions: [
        { text: 'Document the setup script', priority: 85 },
      ],
      agentProjectSuggestions: [],
    })

    expect(merged).toEqual([
      { text: 'Document the setup script', priority: 85, source: 'judge+agent' },
      { text: 'Describe the test harness', priority: 40, source: 'judge' },
    ])
  })

  it('reads coding-agent suggestions defensively', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-docs-writer-test-'))
    tempPaths.push(repoDir)

    fs.writeFileSync(
      path.join(repoDir, CODING_AGENT_SUGGESTIONS_FILE),
      JSON.stringify({
        docSuggestions: [{ text: 'Add docs', priority: 70 }],
        projectSuggestions: [{ text: 'Add tests', priority: 55 }],
      }),
    )

    expect(readCodingAgentSuggestions(repoDir)).toEqual({
      docSuggestions: [{ text: 'Add docs', priority: 70 }],
      projectSuggestions: [{ text: 'Add tests', priority: 55 }],
    })
  })

  it('filters low-priority doc suggestions before docs planning', () => {
    expect(filterDocSuggestionsForPlanning([
      { text: 'Keep me', priority: 70, source: 'judge' },
      { text: 'Drop me', priority: 25, source: 'agent' },
    ])).toEqual([
      { text: 'Keep me', priority: 70, source: 'judge' },
    ])
  })
})
