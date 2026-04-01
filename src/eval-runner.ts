import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { ClaudeRunner } from './runners/claude'
import { judgeTaskResult } from './judge'
import { compressTrace } from './trace-compressor'
import { applyCarveOperations, copyDocsIntoRepo, extractDocsRead } from './eval-helpers'

import type { CarvedFeature } from './carve-features'
import type { JudgingResult } from './judge'
import type { RunnerResult } from './runners/runner'

export interface TaskResult {
  featureId: string
  prompt: string
  score: number
  diff: string
  trace: string
  judging: JudgingResult
  costEstimate: number
  docsRead: string[]
}

export async function runAgentOnCarve(opts: {
  idx: number
  total: number
  repoPath: string
  feature: CarvedFeature
  initCommand?: string
  model: string
  groundTruthDiff: string
  docsSourcePath: string
}): Promise<TaskResult> {
  const { idx, total, repoPath, feature, initCommand, model, groundTruthDiff, docsSourcePath } = opts

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-eval-'))
  const repoDir = path.join(tempDir, 'repo')
  let traceDir: string | undefined

  try {
    // Clone the repo
    execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
    const headSha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()
    execSync(`git checkout ${headSha}`, { cwd: repoDir, stdio: 'ignore' })

    // Apply carve (remove the feature)
    applyCarveOperations(repoDir, feature.operations)

    // Commit carved state
    execSync('git add -A', { cwd: repoDir, stdio: 'ignore' })
    execSync(`git commit -m "carve: remove ${feature.id}" --allow-empty`, { cwd: repoDir, stdio: 'ignore' })

    // Copy docs into the carved repo
    copyDocsIntoRepo(docsSourcePath, repoDir)

    // Run init command
    if (initCommand) {
      try {
        execSync(initCommand, { cwd: repoDir, stdio: 'ignore', timeout: 120000 })
      } catch (e) {
        console.warn(`  [Run ${idx + 1}/${total}] Init command failed: ${e}`)
      }
    }

    // Run coding agent
    console.log(`  [Run ${idx + 1}/${total}] Running claude (${model}) for ${feature.id}...`)
    const runner = new ClaudeRunner(repoDir, {}, model, 'medium')

    let result: RunnerResult
    try {
      result = await runner.run(feature.prompt)
    } catch (runError) {
      const errMsg = runError instanceof Error ? runError.message : String(runError)
      console.warn(`  [Run ${idx + 1}/${total}] Agent failed: ${errMsg.slice(0, 200)}`)
      return {
        featureId: feature.id,
        prompt: feature.prompt,
        score: -1,
        diff: '',
        trace: `Agent error: ${errMsg}`,
        judging: {
          analysis: `Agent failed: ${errMsg.slice(0, 500)}`,
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

    const rawTrace = result.steps.map((step) => JSON.stringify(step)).join('\n')
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-traces-'))
    const compressed = compressTrace(rawTrace, traceDir)
    const agentTrace = compressed.inline

    // Judge with Codex reviewer
    console.log(`  [Run ${idx + 1}/${total}] Judging ${feature.id} with Codex reviewer...`)
    let judging: JudgingResult
    try {
      judging = await judgeTaskResult({
        taskPrompt: feature.prompt,
        agentDiff: result.diff,
        groundTruthDiff,
        repoDir: repoDir,
      })
    } catch (judgeError) {
      const errMsg = judgeError instanceof Error ? judgeError.message : String(judgeError)
      console.warn(`  [Run ${idx + 1}/${total}] Judge failed: ${errMsg.slice(0, 200)}`)
      judging = {
        analysis: `Judge failed: ${errMsg.slice(0, 500)}`,
        strengths: [],
        weaknesses: ['Judge failed'],
        e2eTestsPerformed: [],
        completionScore: 0,
        codeQualityScore: 0,
        e2eScore: 0,
        overallScore: 0,
      }
    }

    return {
      featureId: feature.id,
      prompt: feature.prompt,
      score: judging.overallScore,
      diff: result.diff,
      trace: agentTrace,
      judging,
      costEstimate: result.totalCostUsd,
      docsRead: extractDocsRead(result.steps),
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch { /* ignore */ }
    try {
      if (traceDir) fs.rmSync(traceDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}
