/**
 * Overnight evaluation run.
 *
 * One long pipeline meant to run unattended:
 *   1. Plan features to carve (GPT-5.4 via OpenAI SDK)
 *   2. Carve a random subset of n features (GPT-5.4 via OpenAI SDK)
 *   3. Baseline: rebuild each in parallel (Claude Code + Sonnet), judge (GPT-5.4), get scores + doc suggestions
 *   4. Loop N times:
 *      a. Docs refactor agent reads judge suggestions and edits all docs holistically (Claude Code + Opus)
 *      b. Re-eval: rebuild in parallel (Claude Code + Sonnet), judge (GPT-5.4), get new scores + doc suggestions
 *
 * Usage:
 *   bun run src/run-overnight.ts --repo /path/to/repo [--n 5] [--parallelism 3] [--loops 3] [--init-command "npm install"]
 */
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  planFeatures,
  carveFeature,
} from './carve-features'
import { ClaudeRunner } from './runners/claude'
import { judgeTaskResult } from './judge'
import { compressTrace } from './trace-compressor'

import type { CarvedFeature, CarveCandidate, FileOperation } from './carve-features'
import type { JudgingResult } from './judge'
import type { RunnerResult, AgentStep } from './runners/runner'

// --- Types ---

export interface OvernightOptions {
  repoPath: string
  n: number            // number of features to randomly select
  parallelism: number  // parallel agent runs per eval round
  loops: number        // number of improvement loops (default 3)
  initCommand?: string
  codingModel: string  // model for coding agents (default: sonnet)
  docsModel: string    // model for docs agents (default: opus)
}

interface TaskResult {
  featureId: string
  prompt: string
  score: number
  diff: string
  trace: string
  judging: JudgingResult
  costEstimate: number
  docsRead: string[]
}

interface RoundResult {
  round: number
  tasks: TaskResult[]
  avgScore: number
  totalCost: number
}

interface OvernightSummary {
  repoPath: string
  startTime: string
  endTime: string
  featuresCarved: number
  rounds: Array<{
    round: number
    avgScore: number
    scores: Record<string, number>
    totalCost: number
  }>
  totalCost: number
  scoreProgression: number[] // avg score per round
}

// --- Helpers ---

function selectRandom<T>(items: T[], count: number): T[] {
  const shuffled = [...items].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

function applyCarveOperations(repoDir: string, operations: FileOperation[]): void {
  for (const op of operations) {
    const fullPath = path.join(repoDir, op.path)
    if (op.action === 'delete') {
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath)
      }
    } else if (op.action === 'modify' && op.newContent !== undefined) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, op.newContent)
    }
  }
}

const DOC_PATH_PATTERN = /(?:^|\/)(?:docs\/|AGENTS\.md|CLAUDE\.md)/

function extractDocsRead(steps: AgentStep[]): string[] {
  const seen = new Set<string>()
  for (const step of steps) {
    if (step.type !== 'tool_call') continue
    // Claude Code uses Read/Glob/Grep; Codex uses shell commands
    const filePath: string | undefined =
      step.input?.file_path || step.input?.path || step.input?.command
    if (typeof filePath !== 'string') continue

    // For Read/Glob tool calls, check the file_path directly
    if ((step.toolName === 'Read' || step.toolName === 'read_file') && DOC_PATH_PATTERN.test(filePath)) {
      // Extract relative path from absolute path
      const match = filePath.match(/((?:docs\/\S+|AGENTS\.md|CLAUDE\.md))/)
      if (match) seen.add(match[1])
    }
    // For shell commands (codex), look for cat/less/head/sed on doc files
    if (step.toolName === 'shell' && DOC_PATH_PATTERN.test(filePath)) {
      const matches = filePath.match(/((?:docs\/\S+|AGENTS\.md|CLAUDE\.md))/g)
      if (matches) for (const m of matches) seen.add(m)
    }
  }
  return [...seen].sort()
}

function computeGroundTruthDiff(feature: CarvedFeature): string {
  const diffs: string[] = []
  for (const op of feature.operations) {
    if (op.action === 'delete' && feature.originalFiles[op.path]) {
      const lines = feature.originalFiles[op.path].split('\n')
      diffs.push(
        `--- /dev/null\n+++ b/${op.path}\n@@ -0,0 +1,${lines.length} @@\n` +
          lines.map((l) => `+${l}`).join('\n'),
      )
    } else if (op.action === 'modify' && feature.originalFiles[op.path]) {
      const origLines = feature.originalFiles[op.path].split('\n')
      const carvedLines = (op.newContent || '').split('\n')
      diffs.push(
        `--- a/${op.path}\n+++ b/${op.path}\n@@ -1,${carvedLines.length} +1,${origLines.length} @@\n` +
          carvedLines.map((l) => `-${l}`).join('\n') + '\n' +
          origLines.map((l) => `+${l}`).join('\n'),
      )
    }
  }
  return diffs.join('\n\n')
}

function copyDocsIntoRepo(sourceRepoPath: string, targetRepoPath: string): void {
  const sourceDocsDir = path.join(sourceRepoPath, 'docs')
  const sourceAgentsMd = path.join(sourceRepoPath, 'AGENTS.md')
  const sourceClaudeMd = path.join(sourceRepoPath, 'CLAUDE.md')
  const targetDocsDir = path.join(targetRepoPath, 'docs')

  let copied = false
  if (fs.existsSync(sourceDocsDir)) {
    fs.cpSync(sourceDocsDir, targetDocsDir, { recursive: true })
    copied = true
  }
  if (fs.existsSync(sourceAgentsMd)) {
    fs.cpSync(sourceAgentsMd, path.join(targetRepoPath, 'AGENTS.md'))
    copied = true
  }
  if (fs.existsSync(sourceClaudeMd)) {
    fs.cpSync(sourceClaudeMd, path.join(targetRepoPath, 'CLAUDE.md'))
    copied = true
  }

  if (copied) {
    try {
      execSync(
        'git add docs/ AGENTS.md CLAUDE.md 2>/dev/null; git add -u docs/ AGENTS.md CLAUDE.md 2>/dev/null',
        { cwd: targetRepoPath, stdio: 'ignore' },
      )
      execSync('git commit -m "evalbuff: pre-load docs" --allow-empty', {
        cwd: targetRepoPath,
        stdio: 'ignore',
      })
    } catch {
      // fine
    }
  }
}

function getDocsSnapshot(repoPath: string): Record<string, string> {
  const docs: Record<string, string> = {}
  const docsDir = path.join(repoPath, 'docs')

  if (fs.existsSync(docsDir)) {
    function readDir(dir: string, prefix: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          readDir(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        } else if (entry.name.endsWith('.md')) {
          docs[`docs/${prefix}${entry.name}`] = fs.readFileSync(path.join(dir, entry.name), 'utf-8')
        }
      }
    }
    readDir(docsDir, '')
  }

  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const p = path.join(repoPath, file)
    if (fs.existsSync(p)) {
      docs[file] = fs.readFileSync(p, 'utf-8')
    }
  }

  return docs
}

function computeDocsDiffText(before: Record<string, string>, after: Record<string, string>): string {
  const lines: string[] = []
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])

  for (const key of [...allKeys].sort()) {
    if (!(key in before)) {
      lines.push(`\n=== NEW FILE: ${key} ===`)
      lines.push(after[key])
    } else if (!(key in after)) {
      lines.push(`\n=== DELETED FILE: ${key} ===`)
      lines.push(`(was ${before[key].split('\n').length} lines)`)
    } else if (before[key] !== after[key]) {
      lines.push(`\n=== MODIFIED FILE: ${key} ===`)
      lines.push(`--- before`)
      lines.push(`+++ after`)
      // Simple line diff
      const oldLines = before[key].split('\n')
      const newLines = after[key].split('\n')
      const maxLen = Math.max(oldLines.length, newLines.length)
      for (let i = 0; i < maxLen; i++) {
        if (i >= oldLines.length) {
          lines.push(`+${newLines[i]}`)
        } else if (i >= newLines.length) {
          lines.push(`-${oldLines[i]}`)
        } else if (oldLines[i] !== newLines[i]) {
          lines.push(`-${oldLines[i]}`)
          lines.push(`+${newLines[i]}`)
        }
      }
    }
  }

  return lines.join('\n')
}

// --- Core: Run a single agent on a carved repo ---

async function runAgentOnCarve(opts: {
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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-eval-'))
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

    // Run coding agent (Claude Code with Sonnet)
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

    // Judge with Codex reviewer agents
    console.log(`  [Run ${idx + 1}/${total}] Judging ${feature.id} with Codex reviewers...`)
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

// --- Run a full evaluation round ---

async function runEvalRound(
  features: CarvedFeature[],
  groundTruthDiffs: Map<string, string>,
  opts: OvernightOptions,
  round: number,
): Promise<RoundResult> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`ROUND ${round} — Evaluating ${features.length} features (parallelism=${opts.parallelism})`)
  console.log(`${'='.repeat(60)}`)

  const results = await Promise.all(
    features.map((feature, i) =>
      runAgentOnCarve({
        idx: i,
        total: features.length,
        repoPath: opts.repoPath,
        feature,
        initCommand: opts.initCommand,
        model: opts.codingModel,
        groundTruthDiff: groundTruthDiffs.get(feature.id) || '',
        docsSourcePath: opts.repoPath,
      }),
    ),
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

// --- Collect doc suggestions from judge results ---

function collectDocSuggestions(tasks: TaskResult[]): string {
  const sections: string[] = []

  for (const task of tasks) {
    const suggestions = task.judging.docSuggestions
    if (!suggestions || suggestions.length === 0) continue

    sections.push(
      `### ${task.featureId} (score: ${task.score.toFixed(1)}/10)\n` +
      suggestions.map((s) => `- ${s}`).join('\n'),
    )
  }

  return sections.join('\n\n')
}

// --- Docs refactor agent (Claude Code + Opus) ---

async function runDocsRefactorAgent(
  repoPath: string,
  judgeSuggestions: string,
  model: string,
): Promise<void> {
  console.log(`\n  [DocsRefactor] Running holistic docs refactor...`)

  const prompt = `Read ALL existing documentation (docs/, AGENTS.md, CLAUDE.md), consider the judge suggestions below, and make the documentation as useful as possible for coding agents.

## Judge Suggestions

Multiple judge agents reviewed coding agent attempts and identified documentation gaps. Here are their suggestions:

${judgeSuggestions || '(No suggestions were made)'}

## What to do

1. **Implement judge suggestions** — the judges tested the code and know what the agents got wrong. Apply their suggestions by creating, updating, or restructuring docs as needed.
2. **Edit existing docs** — when a suggestion says to update an existing doc, make fine-grained edits rather than rewriting from scratch.
3. **Create new docs** — when a suggestion identifies a missing pattern or convention, create a concise new doc for it.
4. **Merge overlapping docs** — if multiple suggestions or existing docs cover similar topics, combine them.
5. **Remove redundancy** — consolidate duplicate advice. Dense, actionable information beats verbose explanations.
6. **Fix contradictions** — if docs disagree, pick the correct advice and remove the wrong one.
7. **Prune stale docs** — remove docs that reference files/patterns that no longer exist in the codebase.

Rules:
- ONLY modify files in docs/, AGENTS.md, or CLAUDE.md. Do NOT modify source code.
- It's OK to delete doc files that are redundant or low-value.
- The goal is a minimal, high-signal set of docs that a coding agent will actually use.
- Less is more — 5 great docs are better than 15 mediocre ones.
- Be specific and actionable — reference concrete file paths, patterns, and conventions.`

  try {
    const runner = new ClaudeRunner(repoPath, {}, model, 'high')
    await runner.run(prompt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  [DocsRefactor] Failed: ${msg.slice(0, 200)}`)
  }
}

// --- Logging ---

function saveRoundResults(logDir: string, roundResult: RoundResult): void {
  const roundDir = path.join(logDir, `round-${roundResult.round}`)
  fs.mkdirSync(roundDir, { recursive: true })

  // Save each task's detailed results
  for (const task of roundResult.tasks) {
    const taskDir = path.join(roundDir, task.featureId)
    fs.mkdirSync(taskDir, { recursive: true })

    fs.writeFileSync(path.join(taskDir, 'trace.txt'), task.trace)
    fs.writeFileSync(path.join(taskDir, 'diff.txt'), task.diff)
    fs.writeFileSync(path.join(taskDir, 'judging.json'), JSON.stringify(task.judging, null, 2))
    fs.writeFileSync(path.join(taskDir, 'score.txt'), task.score.toString())
  }

  // Save round summary
  const summary = {
    round: roundResult.round,
    avgScore: roundResult.avgScore,
    totalCost: roundResult.totalCost,
    tasks: roundResult.tasks.map((t) => ({
      featureId: t.featureId,
      score: t.score,
      costEstimate: t.costEstimate,
    })),
  }
  fs.writeFileSync(path.join(roundDir, 'summary.json'), JSON.stringify(summary, null, 2))
}

function saveSummary(
  logDir: string,
  summary: OvernightSummary,
  roundResults: RoundResult[],
  opts: OvernightOptions,
): void {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2))

  const L: string[] = []
  const push = (...s: string[]) => L.push(...s)

  // --- Header ---
  push(
    '# Evalbuff Overnight Run Report',
    '',
    '## Overview',
    '',
    `| | |`,
    `|---|---|`,
    `| **Repo** | \`${summary.repoPath}\` |`,
    `| **Start** | ${summary.startTime} |`,
    `| **End** | ${summary.endTime} |`,
    `| **Duration** | ${formatDuration(summary.startTime, summary.endTime)} |`,
    `| **Features carved** | ${summary.featuresCarved} |`,
    `| **Improvement loops** | ${opts.loops} |`,
    `| **Coding model** | ${opts.codingModel} |`,
    `| **Docs model** | ${opts.docsModel} |`,
    `| **Total cost** | $${summary.totalCost.toFixed(2)} |`,
    '',
  )

  // --- Score trajectory ---
  push('## Score Trajectory', '')
  push('```')
  for (let i = 0; i < summary.scoreProgression.length; i++) {
    const score = summary.scoreProgression[i]
    const bar = '█'.repeat(Math.round(score * 2))
    const label = i === 0 ? 'baseline' : `loop ${i}`
    push(`${label.padEnd(12)} ${score.toFixed(1).padStart(5)}/10  ${bar}`)
  }
  push('```')

  const delta = summary.scoreProgression.length >= 2
    ? summary.scoreProgression[summary.scoreProgression.length - 1] - summary.scoreProgression[0]
    : 0
  if (delta !== 0) {
    push('', `**Net change:** ${delta > 0 ? '+' : ''}${delta.toFixed(1)} points`)
  }
  push('')

  // --- Per-round score table ---
  push('## Scores by Round', '')

  const featureIds = [...new Set(roundResults.flatMap((r) => r.tasks.map((t) => t.featureId)))]
  const headerCols = ['Feature', ...roundResults.map((r) => r.round === 0 ? 'Baseline' : `Loop ${r.round}`)]
  push(`| ${headerCols.join(' | ')} |`)
  push(`| ${headerCols.map(() => '---').join(' | ')} |`)

  for (const fid of featureIds) {
    const scores = roundResults.map((r) => {
      const task = r.tasks.find((t) => t.featureId === fid)
      if (!task || task.score < 0) return 'FAIL'
      return task.score.toFixed(1)
    })
    push(`| ${fid} | ${scores.join(' | ')} |`)
  }

  const avgRow = roundResults.map((r) => r.avgScore.toFixed(1))
  push(`| **Average** | ${avgRow.join(' | ')} |`)

  const costRow = roundResults.map((r) => `$${r.totalCost.toFixed(2)}`)
  push(`| **Cost** | ${costRow.join(' | ')} |`)
  push('')

  // --- Per-round detail ---
  for (const round of roundResults) {
    const roundLabel = round.round === 0 ? 'Baseline' : `Loop ${round.round}`
    push(`## ${roundLabel} — Detail`, '')

    for (const task of round.tasks) {
      push(`### ${task.featureId} — ${task.score >= 0 ? `${task.score.toFixed(1)}/10` : 'FAILED'}`, '')

      if (task.score < 0) {
        push(`> Agent failed: ${task.judging.analysis.slice(0, 200)}`, '')
        continue
      }

      // Score breakdown
      push(
        `| Completion | Code Quality | E2E | Overall |`,
        `|---|---|---|---|`,
        `| ${task.judging.completionScore.toFixed(1)} | ${task.judging.codeQualityScore.toFixed(1)} | ${task.judging.e2eScore.toFixed(1)} | ${task.judging.overallScore.toFixed(1)} |`,
        '',
      )

      // Analysis
      push(`**Analysis:** ${task.judging.analysis}`, '')

      // Strengths & weaknesses
      if (task.judging.strengths.length > 0) {
        push('**Strengths:**')
        for (const s of task.judging.strengths) push(`- ${s}`)
        push('')
      }
      if (task.judging.weaknesses.length > 0) {
        push('**Weaknesses:**')
        for (const w of task.judging.weaknesses) push(`- ${w}`)
        push('')
      }

      // E2E tests performed
      if (task.judging.e2eTestsPerformed.length > 0) {
        push('**E2E tests performed:**')
        for (const t of task.judging.e2eTestsPerformed) push(`- ${t}`)
        push('')
      }

      // Docs read
      if (task.docsRead.length > 0) {
        push(`**Docs read:** ${task.docsRead.map(d => `\`${d}\``).join(', ')}`, '')
      } else {
        push('**Docs read:** none', '')
      }

      // Doc suggestions
      const suggestions = task.judging.docSuggestions
      if (suggestions && suggestions.length > 0) {
        push('**Doc suggestions:**')
        for (const s of suggestions) push(`- ${s}`)
        push('')
      }

      push(`**Cost:** $${task.costEstimate.toFixed(2)}`, '')
    }

    // Judge suggestions file for non-baseline rounds
    if (round.round > 0) {
      const suggestionsFile = path.join(logDir, `judge-suggestions-loop-${round.round}.txt`)
      if (fs.existsSync(suggestionsFile)) {
        const suggestionsText = fs.readFileSync(suggestionsFile, 'utf-8')
        if (suggestionsText.trim()) {
          push(`### Judge Suggestions Applied (Loop ${round.round})`, '')
          push('```')
          push(suggestionsText)
          push('```', '')
        }
      }
    }

    // Docs diff for non-baseline rounds
    if (round.round > 0) {
      const diffFile = path.join(logDir, `docs-diff-loop-${round.round}.txt`)
      if (fs.existsSync(diffFile)) {
        const diffText = fs.readFileSync(diffFile, 'utf-8')
        if (diffText.trim()) {
          push(`### Docs Changes (Loop ${round.round})`, '')
          push('```diff')
          push(diffText)
          push('```', '')
        }
      }
    }
  }

  // --- Final docs state ---
  const lastLoop = opts.loops
  const finalDocsFile = path.join(logDir, `docs-state-loop-${lastLoop}.json`)
  if (fs.existsSync(finalDocsFile)) {
    const finalDocs: Record<string, string> = JSON.parse(fs.readFileSync(finalDocsFile, 'utf-8'))
    const docKeys = Object.keys(finalDocs).sort()
    if (docKeys.length > 0) {
      push('## Final Documentation State', '')
      for (const key of docKeys) {
        push(`### ${key}`, '')
        push('```markdown')
        push(finalDocs[key])
        push('```', '')
      }
    }
  }

  fs.writeFileSync(path.join(logDir, 'report.md'), L.join('\n'))
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  const mins = Math.floor(ms / 60000)
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hrs > 0) return `${hrs}h ${remainMins}m`
  return `${mins}m`
}

// --- Main orchestrator ---

export async function runOvernight(opts: OvernightOptions): Promise<void> {
  const startTime = new Date().toISOString()
  const logDir = path.join(opts.repoPath, `evalbuff-overnight-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`)
  fs.mkdirSync(logDir, { recursive: true })

  console.log(`\nEvalbuff Overnight Run`)
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

  // Save plan
  fs.writeFileSync(path.join(logDir, 'plan.json'), JSON.stringify(plan, null, 2))

  // --- Step 2: Select random subset and carve ---
  console.log(`\n${'='.repeat(60)}`)
  console.log(`STEP 2: Selecting ${opts.n} random features and carving...`)
  console.log(`${'='.repeat(60)}`)

  const selected = selectRandom(plan.candidates, opts.n)
  console.log(`Selected: ${selected.map((c) => c.id).join(', ')}`)

  const features: CarvedFeature[] = []
  for (const candidate of selected) {
    try {
      const carved = await carveFeature(opts.repoPath, candidate)
      if (carved) {
        features.push(carved)
        console.log(`  Carved: ${carved.id} — ${carved.operations.length} file operations`)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`  Failed to carve ${candidate.id}: ${msg.slice(0, 200)}`)
    }
  }

  if (features.length === 0) {
    console.error('No features were successfully carved. Aborting.')
    return
  }

  // Pre-compute ground truth diffs
  const groundTruthDiffs = new Map<string, string>()
  for (const feature of features) {
    groundTruthDiffs.set(feature.id, computeGroundTruthDiff(feature))
  }

  // Save carved features
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

    // Save judge suggestions for logging
    fs.writeFileSync(path.join(logDir, `judge-suggestions-loop-${loop}.txt`), judgeSuggestions)

    await runDocsRefactorAgent(opts.repoPath, judgeSuggestions, opts.docsModel)

    // Commit docs changes
    try {
      execSync('git add docs/ AGENTS.md CLAUDE.md 2>/dev/null', { cwd: opts.repoPath, stdio: 'ignore' })
      execSync(`git commit -m "evalbuff: docs refactor (loop ${loop})" --allow-empty`, {
        cwd: opts.repoPath,
        stdio: 'ignore',
      })
    } catch { /* fine */ }

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

  const summary: OvernightSummary = {
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
  console.log('OVERNIGHT RUN COMPLETE')
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
  const parallelism = parseInt(getArg('parallelism', '3'))
  const loops = parseInt(getArg('loops', '3'))
  const initCommand = hasArg('init-command') ? getArg('init-command') : undefined
  const codingModel = getArg('coding-model', 'sonnet')
  const docsModel = getArg('docs-model', 'opus')

  runOvernight({
    repoPath,
    n,
    parallelism,
    loops,
    initCommand,
    codingModel,
    docsModel,
  }).catch((error) => {
    console.error('Overnight run failed:', error)
    process.exit(1)
  })
}
