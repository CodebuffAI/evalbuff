import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, it, mock } from 'bun:test'

import { events } from '../tui/events'

async function waitForFlushedEvents(logDir: string): Promise<string> {
  const eventsPath = path.join(logDir, 'events.jsonl')

  for (let attempt = 0; attempt < 50; attempt++) {
    if (fs.existsSync(eventsPath)) {
      const text = fs.readFileSync(eventsPath, 'utf-8')
      if (text.includes('"type":"run_complete"')) {
        return text
      }
    }
    await Bun.sleep(20)
  }

  throw new Error(`Timed out waiting for flushed events at ${eventsPath}`)
}

describe('runEvalbuff orchestration', () => {
  let repoDir: string | undefined

  afterEach(() => {
    events.close()
    events.clearBuffer()
    mock.restore()
    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true })
      repoDir = undefined
    }
  })

  it('emits explicit carve failures and terminal events when all selected carves fail', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-evalbuff-orch-'))

    mock.module('../carve-features', () => ({
      planFeatures: async () => ({
        reasoning: 'test',
        candidates: [
          {
            id: 'throwing-feature',
            name: 'Throwing feature',
            prompt: 'Rebuild throwing feature',
            description: 'Throws during carve',
            files: [],
            relevantFiles: [],
            complexity: 'small' as const,
          },
          {
            id: 'noop-feature',
            name: 'No-op feature',
            prompt: 'Rebuild noop feature',
            description: 'Produces no carve diff',
            files: [],
            relevantFiles: [],
            complexity: 'small' as const,
          },
        ],
      }),
      carveFeature: async (_repoPath: string, candidate: { id: string }) => {
        if (candidate.id === 'throwing-feature') {
          throw new Error('worktree add failed')
        }
        return null
      },
    }))

    const { runEvalbuff } = await import('../run-evalbuff')
    await runEvalbuff({
      repoPath: repoDir,
      n: 2,
      codingModel: 'sonnet',
      docsModel: 'opus',
    })

    let logDir: string | undefined
    events.replay(({ event }) => {
      if (event.type === 'run_start') {
        logDir = event.logDir
      }
    })

    expect(logDir).toBeDefined()
    const rawEvents = await waitForFlushedEvents(logDir as string)
    const parsedEvents = rawEvents.trim().split('\n').map((line) => JSON.parse(line).event)

    expect(parsedEvents).toContainEqual({
      type: 'feature_status',
      featureId: 'throwing-feature',
      status: 'carve_failed',
      detail: 'worktree add failed',
    })
    expect(parsedEvents).toContainEqual({
      type: 'feature_status',
      featureId: 'noop-feature',
      status: 'carve_failed',
      detail: 'Carve produced no changes.',
    })
    expect(parsedEvents).toContainEqual({
      type: 'phase_change',
      phase: 'complete',
      detail: 'Run aborted: no features were successfully carved.',
    })
    expect(parsedEvents.at(-1)).toEqual({
      type: 'run_complete',
      scoreProgression: [],
      totalCost: 0,
      duration: expect.any(String),
    })
  })
})
