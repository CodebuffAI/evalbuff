/**
 * Overnight evaluation run.
 *
 * One long pipeline meant to run unattended:
 *   1. Plan features to carve (GPT-5.4 via OpenAI SDK)
 *   2. Carve a random subset of n features (GPT-5.4 via OpenAI SDK)
 *   3. Baseline: rebuild each in parallel (Claude Code + Sonnet), judge (GPT-5.4), get scores + traces
 *   4. Loop N times:
 *      a. Sequentially: docs-writer agent per task analyzes traces → makes generalizable docs changes (Claude Code + Opus)
 *      b. Holistic docs refactor agent simplifies/merges/compacts all docs (Claude Code + Opus)
 *      c. Re-eval: rebuild in parallel (Claude Code + Sonnet), judge (GPT-5.4), get new scores + traces
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
import { judgeWithOpenAI } from './judge-openai'
import { ClaudeRunner } from './runners/claude'

import type { CarvedFeature, CarveCandidate, FileOperation } from './carve-features'
import type { JudgingResult } from './judge'
import type { RunnerResult } from './runners/runner'

// --- Types ---

interface OvernightOptions {
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
      }
    }

    const agentTrace = result.steps.map((step) => JSON.stringify(step)).join('\n')

    // Judge with GPT-5.4
    console.log(`  [Run ${idx + 1}/${total}] Judging ${feature.id} with GPT-5.4...`)
    let judging: JudgingResult
    try {
      judging = await judgeWithOpenAI({
        taskPrompt: feature.prompt,
        agentDiff: result.diff,
        groundTruthDiff,
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
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
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

// --- Docs writer agent (Claude Code + Opus) ---

async function runDocsWriterAgent(
  repoPath: string,
  task: TaskResult,
  model: string,
): Promise<void> {
  console.log(`\n  [DocsWriter] Analyzing ${task.featureId} (score: ${task.score.toFixed(1)})...`)

  // Write context to a temp file in the repo
  const contextPath = path.join(repoPath, 'EVALBUFF_DOCS_CONTEXT.md')

  const contextContent = `# Evalbuff Docs Writer Context

## Task
The coding agent was asked to rebuild a feature that was carved out of the codebase.

### Task Prompt
${task.prompt}

### Agent Score: ${task.score.toFixed(1)}/10

### Judge Analysis
${task.judging.analysis}

### Strengths
${task.judging.strengths.map((s) => `- ${s}`).join('\n') || '- None noted'}

### Weaknesses
${task.judging.weaknesses.map((w) => `- ${w}`).join('\n') || '- None noted'}

### Agent's Diff (what the agent produced)
\`\`\`diff
${task.diff.slice(0, 20000) || '(No changes made)'}
\`\`\`

### Agent Trace (reasoning and tool calls, truncated)
\`\`\`
${task.trace.slice(0, 30000)}
${task.trace.length > 30000 ? '\n... (truncated)' : ''}
\`\`\`
`

  fs.writeFileSync(contextPath, contextContent)

  const prompt = `Read the file EVALBUFF_DOCS_CONTEXT.md in the current directory. It contains the results of a coding agent's attempt at rebuilding a feature.

Your job: Analyze what went wrong (or right) and make GENERALIZABLE documentation improvements that would help a coding agent perform better on FUTURE similar tasks.

Rules:
1. ONLY modify files in docs/, AGENTS.md, or CLAUDE.md. Do NOT modify any source code.
2. Write docs that capture GENERAL PATTERNS, not task-specific fixes. Think: "What would a senior dev tell a new team member?"
3. Be specific and actionable — reference concrete file paths, patterns, and conventions from this codebase.
4. Keep docs concise — dense information beats verbose explanations. Every line should be actionable.
5. If existing docs are stale, outdated, or redundant — clean them up or remove them.
6. If you see docs that are too verbose, make them more concise.
7. If the agent scored 9+, there may not be much to improve — that's fine, focus on cleanup.
8. Do NOT create a doc if the failure is too task-specific to generalize.

After reading the context file, delete EVALBUFF_DOCS_CONTEXT.md when you're done.`

  try {
    const runner = new ClaudeRunner(repoPath, {}, model)
    await runner.run(prompt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  [DocsWriter] Failed for ${task.featureId}: ${msg.slice(0, 200)}`)
  }

  // Clean up context file if the agent didn't
  if (fs.existsSync(contextPath)) {
    fs.rmSync(contextPath)
  }
}

// --- Docs refactor agent (Claude Code + Opus) ---

async function runDocsRefactorAgent(
  repoPath: string,
  docsDiffText: string,
  model: string,
): Promise<void> {
  console.log(`\n  [DocsRefactor] Running holistic docs refactor...`)

  // Write the diff context
  const diffPath = path.join(repoPath, 'EVALBUFF_DOCS_DIFF.md')

  const diffContent = `# Recent Docs Changes

The following changes were made to the documentation in the previous step by per-task docs writers.
Review these changes in context of ALL existing docs and improve the overall quality.

${docsDiffText || '(No changes were made)'}
`

  fs.writeFileSync(diffPath, diffContent)

  const prompt = `Read the file EVALBUFF_DOCS_DIFF.md which shows recent documentation changes made by per-task doc writers.

Your job: Look at ALL documentation (docs/, AGENTS.md, CLAUDE.md) holistically and improve it.

What to do:
1. **Merge overlapping docs** — if multiple docs cover similar topics, combine them into one clear doc.
2. **Remove redundancy** — if the same advice appears in multiple places, consolidate it.
3. **Make everything more concise** — dense, actionable information is better than verbose explanations. Cut fluff.
4. **Fix contradictions** — if docs disagree, pick the correct advice and remove the wrong one.
5. **Improve organization** — group related docs logically. Use clear file paths.
6. **Prune stale docs** — remove docs that reference files/patterns that no longer exist in the codebase.
7. **Polish the new additions** — the recent changes may be rough; clean them up and integrate them properly.

Rules:
- ONLY modify files in docs/, AGENTS.md, or CLAUDE.md. Do NOT modify source code.
- It's OK to delete doc files that are redundant or low-value.
- The goal is a minimal, high-signal set of docs that a coding agent will actually use.
- Less is more — 5 great docs are better than 15 mediocre ones.

After you're done, delete EVALBUFF_DOCS_DIFF.md.`

  try {
    const runner = new ClaudeRunner(repoPath, {}, model)
    await runner.run(prompt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  [DocsRefactor] Failed: ${msg.slice(0, 200)}`)
  }

  // Clean up
  if (fs.existsSync(diffPath)) {
    fs.rmSync(diffPath)
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

function saveSummary(logDir: string, summary: OvernightSummary): void {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2))

  // Also write a human-readable report
  const lines: string[] = [
    '# Evalbuff Overnight Run Report',
    '',
    `**Repo:** ${summary.repoPath}`,
    `**Start:** ${summary.startTime}`,
    `**End:** ${summary.endTime}`,
    `**Features carved:** ${summary.featuresCarved}`,
    `**Total cost:** $${summary.totalCost.toFixed(2)}`,
    '',
    '## Score Progression',
    '',
    '| Round | Avg Score | Details |',
    '|-------|-----------|---------|',
  ]

  for (const round of summary.rounds) {
    const details = Object.entries(round.scores)
      .map(([id, score]) => `${id}: ${score.toFixed(1)}`)
      .join(', ')
    lines.push(`| ${round.round} | ${round.avgScore.toFixed(1)} | ${details} |`)
  }

  lines.push('')
  lines.push('## Score Trajectory')
  lines.push('```')
  for (let i = 0; i < summary.scoreProgression.length; i++) {
    const score = summary.scoreProgression[i]
    const bar = '#'.repeat(Math.round(score))
    const label = i === 0 ? 'baseline' : `loop ${i}`
    lines.push(`${label.padEnd(12)} ${score.toFixed(1).padStart(5)} ${bar}`)
  }
  lines.push('```')

  fs.writeFileSync(path.join(logDir, 'report.md'), lines.join('\n'))
}

// --- Main orchestrator ---

async function runOvernight(opts: OvernightOptions): Promise<void> {
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

    // 4a: Sequential docs writing per task
    console.log(`\n--- Step 4a: Docs writer agents (${previousResults.tasks.length} tasks) ---`)
    const docsSnapshotBefore = getDocsSnapshot(opts.repoPath)

    for (const task of previousResults.tasks) {
      if (task.score < 0) {
        console.log(`  Skipping ${task.featureId} (agent failed)`)
        continue
      }
      await runDocsWriterAgent(opts.repoPath, task, opts.docsModel)
    }

    // Commit docs changes from writers
    try {
      execSync('git add docs/ AGENTS.md CLAUDE.md 2>/dev/null', { cwd: opts.repoPath, stdio: 'ignore' })
      execSync(`git commit -m "evalbuff: docs writer changes (loop ${loop})" --allow-empty`, {
        cwd: opts.repoPath,
        stdio: 'ignore',
      })
    } catch { /* fine */ }

    // 4b: Holistic docs refactor
    console.log(`\n--- Step 4b: Holistic docs refactor ---`)
    const docsSnapshotAfterWriters = getDocsSnapshot(opts.repoPath)
    const docsDiffText = computeDocsDiffText(docsSnapshotBefore, docsSnapshotAfterWriters)

    // Save docs diff
    fs.writeFileSync(path.join(logDir, `docs-diff-loop-${loop}.txt`), docsDiffText)

    await runDocsRefactorAgent(opts.repoPath, docsDiffText, opts.docsModel)

    // Commit refactor changes
    try {
      execSync('git add docs/ AGENTS.md CLAUDE.md 2>/dev/null', { cwd: opts.repoPath, stdio: 'ignore' })
      execSync(`git commit -m "evalbuff: docs refactor (loop ${loop})" --allow-empty`, {
        cwd: opts.repoPath,
        stdio: 'ignore',
      })
    } catch { /* fine */ }

    // Save final docs state for this loop
    const docsAfterRefactor = getDocsSnapshot(opts.repoPath)
    fs.writeFileSync(
      path.join(logDir, `docs-state-loop-${loop}.json`),
      JSON.stringify(docsAfterRefactor, null, 2),
    )

    // 4c: Re-eval with updated docs
    console.log(`\n--- Step 4c: Re-evaluation with updated docs ---`)
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

  saveSummary(logDir, summary)

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
