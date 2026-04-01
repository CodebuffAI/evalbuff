import { describe, expect, it } from 'bun:test'

import { runAgentOnCarve } from '../eval-runner'

import type { CarvedFeature } from '../carve-features'

describe('runAgentOnCarve', () => {
  it('returns score -1 for infrastructure failures before the agent ever runs', async () => {
    const feature: CarvedFeature = {
      id: 'broken-repo',
      prompt: 'Restore the broken feature',
      description: 'A feature used to verify infra-failure handling',
      complexity: 'small',
      originalFiles: {},
      operations: [],
      diff: 'diff --git a/a b/a\n',
    }

    const result = await runAgentOnCarve({
      idx: 0,
      total: 1,
      repoPath: '/tmp/evalbuff-repo-that-does-not-exist',
      feature,
      model: 'sonnet',
      groundTruthDiff: feature.diff,
      docsSourcePath: '/tmp/evalbuff-repo-that-does-not-exist',
    })

    expect(result.score).toBe(-1)
    expect(result.judging.overallScore).toBe(-1)
    expect(result.trace).toContain('Agent error:')
    expect(result.diff).toBe('')
  })
})
