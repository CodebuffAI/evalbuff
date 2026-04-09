import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { ClaudeRunner } from './runners/claude'
import { buildCodingAgentPrompt, CODING_AGENT_SUGGESTIONS_FILE, readCodingAgentSuggestions } from './docs-writer'
import { judgeTaskResult } from './judge'
import { applyCarveOperations, copyDocsIntoRepo, ensureGitIdentity, extractDocsRead } from './eval-helpers'

import type { CarvedFeature } from './carve-features'
import type { JudgingResult, Suggestion } from './judge'
import type { RunnerResult } from './runners/runner'

import { execFileSync } from 'child_process'

export interface TaskResult {
  featureId: string
  prompt: string
  score: number
  diff: string
  trace: string
  judging: JudgingResult
  costEstimate: number
  docsRead: string[]
  agentDocSuggestions: Suggestion[]
  agentProjectSuggestions: Suggestion[]
}

type RunAgentOnCarveDeps = {
  createRunner: (repoDir: string, model: string) => { run: (prompt: string) => Promise<RunnerResult> }
  buildCodingAgentPrompt: typeof buildCodingAgentPrompt
  judgeTaskResult: typeof judgeTaskResult
  readCodingAgentSuggestions: typeof readCodingAgentSuggestions
}

const defaultRunAgentOnCarveDeps: RunAgentOnCarveDeps = {
  createRunner: (repoDir, model) => new ClaudeRunner(repoDir, {}, model, 'medium'),
  buildCodingAgentPrompt,
  judgeTaskResult,
  readCodingAgentSuggestions,
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
}, deps: RunAgentOnCarveDeps = defaultRunAgentOnCarveDeps): Promise<TaskResult> {
  const { idx, total, repoPath, feature, initCommand, model, groundTruthDiff, docsSourcePath } = opts

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-eval-'))
  const repoDir = path.join(tempDir, 'repo')

  try {
    try {
      // Clone the repo
      execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
      const headSha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()
      execSync(`git checkout ${headSha}`, { cwd: repoDir, stdio: 'ignore' })
      ensureGitIdentity(repoDir)

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
        } catch {
          // Init command failure is non-fatal
        }
      }

      const runner = deps.createRunner(repoDir, model)

      let result: RunnerResult
      try {
        result = await runner.run(deps.buildCodingAgentPrompt(feature.prompt))
      } catch (runError) {
        return createInfrastructureFailureResult(feature, runError)
      }

      const agentSuggestions = deps.readCodingAgentSuggestions(repoDir)
      try {
        fs.rmSync(path.join(repoDir, CODING_AGENT_SUGGESTIONS_FILE), { force: true })
      } catch {
        // Ignore cleanup failures
      }
      // Preserve the runner's diff, which may already be captured relative to
      // the pre-run base SHA and can include committed agent changes.
      const diff = result.diff

      // Raw JSONL trace — compression happens later when the trace is saved
      // to disk by saveRoundResults() in report.ts via compressAndSave().
      const agentTrace = result.steps.map((step) => JSON.stringify(step)).join('\n')

      const JUDGE_TIMEOUT_MS = 35 * 60 * 1000
      let judging: JudgingResult
      try {
        judging = await Promise.race([
          deps.judgeTaskResult({
            taskPrompt: feature.prompt,
            agentDiff: diff,
            groundTruthDiff,
            repoDir: repoDir,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Judge timed out after ${JUDGE_TIMEOUT_MS / 1000}s`)), JUDGE_TIMEOUT_MS),
          ),
        ])
      } catch (judgeError) {
        const errMsg = judgeError instanceof Error ? judgeError.message : String(judgeError)
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
        diff,
        trace: agentTrace,
        judging,
        costEstimate: result.totalCostUsd,
        docsRead: extractDocsRead(result.steps),
        agentDocSuggestions: agentSuggestions.docSuggestions,
        agentProjectSuggestions: agentSuggestions.projectSuggestions,
      }
    } catch (error) {
      return createInfrastructureFailureResult(feature, error)
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

/**
 * Re-judge a task using the current docs in docsSourcePath.
 *
 * Recreates the exact repo state the original judge saw (carved repo + agent's
 * baseline diff applied), but with whatever docs currently live in
 * docsSourcePath instead of the baseline-era docs. This isolates whether the
 * judge itself scores differently once given better docs, independent of any
 * agent behavior change.
 */
export async function rejudgeTaskWithCurrentDocs(opts: {
  idx: number
  total: number
  repoPath: string
  feature: CarvedFeature
  agentDiff: string
  groundTruthDiff: string
  initCommand?: string
  docsSourcePath: string
}): Promise<JudgingResult> {
  const { idx, total, repoPath, feature, agentDiff, groundTruthDiff, initCommand, docsSourcePath } = opts

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-rejudge-'))
  const repoDir = path.join(tempDir, 'repo')

  try {
    // Clone and check out the same base SHA
    execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
    const headSha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()
    execSync(`git checkout ${headSha}`, { cwd: repoDir, stdio: 'ignore' })
    ensureGitIdentity(repoDir)

    // Apply carve, matching the original eval setup
    applyCarveOperations(repoDir, feature.operations)
    execSync('git add -A', { cwd: repoDir, stdio: 'ignore' })
    execSync(`git commit -m "carve: remove ${feature.id}" --allow-empty`, { cwd: repoDir, stdio: 'ignore' })

    // Copy CURRENT docs (which have been refactored by loop N) into the repo
    copyDocsIntoRepo(docsSourcePath, repoDir)

    // Apply the baseline agent's diff to reproduce the state the judge saw
    if (agentDiff.trim()) {
      const patchPath = path.join(tempDir, 'baseline.patch')
      fs.writeFileSync(patchPath, agentDiff.endsWith('\n') ? agentDiff : agentDiff + '\n')
      try {
        execFileSync('git', ['apply', '--whitespace=nowarn', '--allow-empty', patchPath], {
          cwd: repoDir,
          stdio: 'ignore',
        })
      } catch (applyErr) {
        // Fall back to 3-way apply; if that fails, propagate — rejudge is meaningless without the diff
        execFileSync('git', ['apply', '--3way', '--whitespace=nowarn', patchPath], {
          cwd: repoDir,
          stdio: 'ignore',
        })
      }
    }

    // Re-init (e.g. npm install) — the judge may need a runnable repo for E2E testing
    if (initCommand) {
      try {
        execSync(initCommand, { cwd: repoDir, stdio: 'ignore', timeout: 120000 })
      } catch {
        // Init command failure is non-fatal
      }
    }

    const JUDGE_TIMEOUT_MS = 35 * 60 * 1000
    return await Promise.race([
      judgeTaskResult({
        taskPrompt: feature.prompt,
        agentDiff,
        groundTruthDiff,
        repoDir,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Rejudge timed out after ${JUDGE_TIMEOUT_MS / 1000}s`)), JUDGE_TIMEOUT_MS),
      ),
    ])
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

export async function rejudgeBaselineWithCurrentDocs(opts: {
  idx: number
  total: number
  repoPath: string
  feature: CarvedFeature
  baselineDiff: string
  groundTruthDiff: string
  initCommand?: string
  docsSourcePath: string
}): Promise<JudgingResult> {
  return rejudgeTaskWithCurrentDocs({
    ...opts,
    agentDiff: opts.baselineDiff,
  })
}

function createInfrastructureFailureResult(
  feature: CarvedFeature,
  error: unknown,
): TaskResult {
  const errMsg = error instanceof Error ? error.message : String(error)
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
    agentDocSuggestions: [],
    agentProjectSuggestions: [],
  }
}
