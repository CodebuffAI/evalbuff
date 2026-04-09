/**
 * Perfect Feature — iteratively rebuild a single feature toward a 10/10 score.
 *
 * Unlike run-evalbuff (which runs many features and does holistic doc improvement),
 * this script focuses on ONE feature and tries a series of doc strategies to help
 * the rebuild agent achieve a perfect score — without giving away the answer.
 *
 * Strategies are applied in stages:
 *   Rounds 1-2: General design & style principles
 *   Rounds 3-4: Project knowledge (utilities, framework, common patterns)
 *   Rounds 5-6: Process instructions (e2e testing workflow, verification)
 *   Rounds 7+:  Subagent instructions (spawn a critic/planner/reviewer)
 *
 * Usage:
 *   bun run src/perfect-feature.ts \
 *     --repo /path/to/repo \
 *     --features features.json \
 *     --feature-id my-feature-id \
 *     [--max-rounds 10] \
 *     [--coding-model sonnet] \
 *     [--judge-model opus] \
 *     [--init-command "npm install"]
 */
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { ClaudeRunner } from './runners/claude'
import {
  applyCarveOperations,
  captureGitDiff,
  copyDocsIntoRepo,
  ensureGitIdentity,
  extractDocsRead,
  getDocsSnapshot,
  getGroundTruthDiff,
  computeDocsDiffText,
  syncDocsIntoRepo,
  truncateDiff,
} from './eval-helpers'

import type { CarvedFeature } from './carve-features'
import type { JudgingResult, Suggestion } from './judge'
import type { RunnerResult } from './runners/runner'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PerfectFeatureOptions {
  repoPath: string
  featuresPath: string
  featureId: string
  maxRounds: number
  codingModel: string
  judgeModel: string
  analyzerModel: string
  docsModel: string
  initCommand?: string
  outputDir?: string
}

interface RoundOutcome {
  round: number
  score: number
  judging: JudgingResult
  diff: string
  diagnosis: string
  docsChanged: boolean
  costEstimate: number
}

// ---------------------------------------------------------------------------
// Doc improvement strategies — all available to the analyzer every round
// ---------------------------------------------------------------------------

const ANALYZER_STRATEGY_GUIDE = `You have several categories of doc improvements available. Use whichever ones address the actual failure — often multiple categories apply at once. Use your judgment about which will have the most impact given the diagnosis.

### 1. Design & Style Principles
When to use: The agent's code works but doesn't match project conventions, or the agent made bad structural decisions.
- Code style conventions (naming, file organization, export patterns)
- UI/UX design principles the project follows (if applicable)
- Error handling patterns
- Type conventions and data modeling patterns
- How new features should be structured to match existing code

### 2. Project Knowledge (Utilities, Framework, Reusable Patterns)
When to use: The agent reinvented something that already exists, used the wrong abstraction, or didn't know about a key utility.
- Shared utility functions and where they live
- Framework abstractions (routing, state management, DB access, etc.)
- Common imports and their usage patterns
- Configuration and environment setup
- How existing features compose these building blocks

### 3. Process Instructions (Workflow, Verification, E2E Testing)
When to use: The agent produced code that doesn't build, doesn't pass tests, or has bugs it could have caught by testing.
- A step-by-step workflow: read docs → plan → implement → test → fix
- How to run and verify changes (build commands, test commands, dev server)
- E2E testing steps the agent should perform before declaring done
- How to check for common mistakes (missing imports, unregistered routes, etc.)
- A checklist of things to verify before finishing

### 4. Subagent & Self-Review Instructions
When to use: The agent's first-pass implementation has issues it could catch with a review step, or the task is complex enough to benefit from planning.
- Suggest the agent spawn a "critic" subagent to review its own work before finishing
- Suggest the agent spawn a "planner" subagent before starting implementation
- Suggest the agent re-read its own diff and look for issues
- Suggest the agent run the test suite and fix any failures before finishing
- Suggest the agent use a checklist-driven review process at the end`

// ---------------------------------------------------------------------------
// Custom judge — flexible, allows better-than-ground-truth solutions
// ---------------------------------------------------------------------------

function buildFlexibleJudgePrompt(input: {
  taskPrompt: string
  agentDiff: string
  groundTruthDiff: string
  round: number
}): string {
  const { taskPrompt, agentDiff: rawAgentDiff, groundTruthDiff: rawGroundTruthDiff, round } = input
  const agentDiff = truncateDiff(rawAgentDiff)
  const groundTruthDiff = truncateDiff(rawGroundTruthDiff)

  return `You are a senior engineer performing a thorough code review with hands-on E2E testing.

## Your Mission

An AI coding agent was given a task and produced changes. You must judge how well it did.

**CRITICAL: The ground truth diff below is just ONE valid implementation — a reference, not the answer key.**
The agent's solution may be DIFFERENT from the ground truth and still be PERFECT (10/10).
The agent's solution may even be BETTER than the ground truth.
Do NOT penalize the agent for:
- Using different variable names, file structure, or code organization
- Taking a different architectural approach that achieves the same result
- Adding extra features, tests, or error handling beyond what was asked
- Using different libraries or utilities to accomplish the same thing

DO penalize the agent for:
- Missing functionality (the feature doesn't work or is incomplete)
- Bugs (runtime errors, logic errors, broken edge cases)
- Build/type errors
- Not following the project's existing conventions (if docs describe them)
- Leaving dead code, TODO comments, or unfinished scaffolding

## How to Judge

1. **Read the project docs** (docs/, AGENTS.md, CLAUDE.md) to understand conventions
2. **Review the agent's diff** for completeness and correctness
3. **Actually test the changes end-to-end:**
   - Run the build/compile step
   - Run the test suite
   - Start the dev server if applicable
   - Exercise the feature manually (browser tools, curl, CLI)
   - Check logs for errors
   - Test edge cases
4. **Compare against ground truth** only to understand what SHOULD work, not to require identical code
5. **Write your judgment** to evalbuff-review-result.json

## User Prompt (What the agent was asked to do)
${taskPrompt}

## Ground Truth (One valid reference implementation — NOT the required approach)
\`\`\`diff
${groundTruthDiff}
\`\`\`

## Agent's Changes
\`\`\`diff
${agentDiff || '(No changes made)'}
\`\`\`

## Scoring Guide

- **10/10**: Feature works completely. Builds, passes tests, works end-to-end. May differ from ground truth.
- **8-9/10**: Feature mostly works but has minor issues (cosmetic bugs, missing edge case, slight convention mismatch).
- **6-7/10**: Core feature works but significant issues (broken edge cases, missing pieces, convention violations).
- **4-5/10**: Partially working — some functionality present but major gaps.
- **1-3/10**: Barely functional or fundamentally broken.
- **0/10**: Nothing useful produced.

## Required Output

Write your judgment to \`evalbuff-review-result.json\`:

\`\`\`json
{
  "analysis": "Detailed analysis of what you tested and found...",
  "strengths": ["strength 1", "strength 2"],
  "weaknesses": ["weakness 1", "weakness 2"],
  "e2eTestsPerformed": ["Test 1", "Test 2"],
  "completionScore": 8,
  "codeQualityScore": 9,
  "e2eScore": 7,
  "overallScore": 8,
  "docSuggestions": [{ "text": "Suggestion 1", "priority": 70 }, { "text": "Suggestion 2", "priority": 40 }]
}
\`\`\`

## Documentation Suggestions

This is round ${round} of an iterative improvement process. Based on what you find, suggest doc changes that would help a coding agent do better WITHOUT giving away the specific implementation. Each suggestion is an object with \`text\` (the suggestion) and \`priority\` (0-100, where 100 is extremely impactful).

Good: "Document that all route handlers must be registered in src/routes/index.ts"
Bad: "Tell the agent to add a UserProfile route to src/routes/index.ts"

Focus on GENERAL PATTERNS that would help with ANY feature, not just this one.

IMPORTANT: You MUST write the result file. Do it as your very last action.`
}

async function runFlexibleJudge(
  repoDir: string,
  input: {
    taskPrompt: string
    agentDiff: string
    groundTruthDiff: string
    round: number
  },
  model: string,
): Promise<JudgingResult> {
  const prompt = buildFlexibleJudgePrompt(input)

  console.log(`  [Judge] Running flexible Claude judge (${model})...`)
  const runner = new ClaudeRunner(repoDir, {}, model, 'high')

  try {
    await runner.run(prompt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  [Judge] Runner failed: ${msg.slice(0, 200)}`)
  }

  // Read result file
  const resultPath = path.join(repoDir, 'evalbuff-review-result.json')
  try {
    if (fs.existsSync(resultPath)) {
      const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
      return {
        analysis: raw.analysis || 'No analysis',
        strengths: Array.isArray(raw.strengths) ? raw.strengths : [],
        weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses : [],
        e2eTestsPerformed: Array.isArray(raw.e2eTestsPerformed) ? raw.e2eTestsPerformed : [],
        completionScore: typeof raw.completionScore === 'number' ? raw.completionScore : raw.overallScore ?? 0,
        codeQualityScore: typeof raw.codeQualityScore === 'number' ? raw.codeQualityScore : raw.overallScore ?? 0,
        e2eScore: typeof raw.e2eScore === 'number' ? raw.e2eScore : raw.overallScore ?? 0,
        overallScore: typeof raw.overallScore === 'number' ? raw.overallScore : 0,
        docSuggestions: Array.isArray(raw.docSuggestions)
          ? raw.docSuggestions.map((s: any) =>
              typeof s === 'string' ? { text: s, priority: 50 } : s
            )
          : undefined,
      }
    }
  } catch (err) {
    console.warn(`  [Judge] Failed to parse result: ${err}`)
  }

  return {
    analysis: 'Judge failed to produce result file',
    strengths: [],
    weaknesses: ['Judge failed'],
    e2eTestsPerformed: [],
    completionScore: 0,
    codeQualityScore: 0,
    e2eScore: 0,
    overallScore: 0,
  }
}

// ---------------------------------------------------------------------------
// Analyzer — diagnoses WHY score isn't 10/10 and suggests doc improvements
// ---------------------------------------------------------------------------

function buildAnalyzerPrompt(input: {
  taskPrompt: string
  agentDiff: string
  groundTruthDiff: string
  judging: JudgingResult
  round: number
  previousDiagnoses: string[]
  currentDocs: Record<string, string>
}): string {
  const { taskPrompt, agentDiff: rawAgentDiff, groundTruthDiff: rawGroundTruthDiff, judging, round, previousDiagnoses, currentDocs } = input
  const agentDiff = truncateDiff(rawAgentDiff)
  const groundTruthDiff = truncateDiff(rawGroundTruthDiff)

  const prevSection = previousDiagnoses.length > 0
    ? `## Previous Diagnoses (what we already tried)\n${previousDiagnoses.map((d, i) => `Round ${i + 1}: ${d}`).join('\n\n')}\n\nDo NOT repeat suggestions that were already tried. Find NEW angles.`
    : ''

  const docsSection = Object.keys(currentDocs).length > 0
    ? `## Current Documentation\n${Object.entries(currentDocs).map(([f, c]) => `### ${f}\n${c}`).join('\n\n')}`
    : '## Current Documentation\n(No docs exist yet)'

  return `You are an expert at analyzing why an AI coding agent failed to perfectly implement a feature, and at writing documentation that would help it succeed next time — WITHOUT giving away the specific answer.

## Context

A coding agent was asked to implement a feature. It scored ${judging.overallScore}/10. This is round ${round} of an iterative improvement process. Your job is to figure out WHY it didn't get 10/10 and suggest documentation changes that would help it (or any agent) do better.

**CRITICAL RULES:**
1. Your doc suggestions must be GENERAL — they should help an agent build ANY feature, not just this one.
2. NEVER include the specific implementation, specific file contents, or specific code that the agent should write.
3. DO document patterns, conventions, architectural rules, utility functions, and workflows.
4. Think about what KNOWLEDGE GAP caused the failure, then fill that gap with general knowledge.

## The Task
${taskPrompt}

## Agent's Attempt (scored ${judging.overallScore}/10)
\`\`\`diff
${agentDiff || '(No changes)'}
\`\`\`

## Judge's Feedback
**Analysis:** ${judging.analysis}
**Strengths:** ${judging.strengths.join(', ') || 'None listed'}
**Weaknesses:** ${judging.weaknesses.join(', ') || 'None listed'}
**E2E tests performed:** ${judging.e2eTestsPerformed.join(', ') || 'None'}
**Judge's doc suggestions:** ${judging.docSuggestions?.map(s => `[P${s.priority}] ${s.text}`).join('\n- ') || 'None'}

## Ground Truth (reference only — the agent should NOT be told this)
\`\`\`diff
${groundTruthDiff}
\`\`\`

${prevSection}

${docsSection}

## Available Improvement Strategies

${ANALYZER_STRATEGY_GUIDE}

## Your Output

Diagnose the root cause, then pick whichever strategies (one or more) best address the failure. Write your result to \`analyzer-result.json\`:

\`\`\`json
{
  "diagnosis": "A 2-3 sentence explanation of the root cause — what knowledge gap or process failure led to the imperfect score",
  "docSuggestions": [
    { "text": "Each suggestion should specify which file to create/update AND include the full content. E.g.: 'Create docs/routing.md: All routes must be registered in src/routes/index.ts by calling registerRoute()...'", "priority": 80 },
    { "text": "Use whichever strategy categories are most relevant to the actual failure", "priority": 60 }
  ]
}
\`\`\`

Remember: The goal is to make docs that help an agent build ANY feature perfectly, not to encode the answer to THIS specific feature. If the agent's failure was highly specific and can't be generalized, say so in your diagnosis and provide minimal/no suggestions.

IMPORTANT: You MUST write analyzer-result.json. Do it as your very last action.`
}

async function runAnalyzer(
  repoDir: string,
  input: {
    taskPrompt: string
    agentDiff: string
    groundTruthDiff: string
    judging: JudgingResult
    round: number
    previousDiagnoses: string[]
    currentDocs: Record<string, string>
  },
  model: string,
): Promise<{ diagnosis: string; docSuggestions: Suggestion[] }> {
  const prompt = buildAnalyzerPrompt(input)

  console.log(`  [Analyzer] Diagnosing failure (${model})...`)
  const runner = new ClaudeRunner(repoDir, {}, model, 'high')

  try {
    await runner.run(prompt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  [Analyzer] Runner failed: ${msg.slice(0, 200)}`)
  }

  const resultPath = path.join(repoDir, 'analyzer-result.json')
  try {
    if (fs.existsSync(resultPath)) {
      const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
      const rawSuggestions = Array.isArray(raw.docSuggestions) ? raw.docSuggestions : []
      return {
        diagnosis: raw.diagnosis || 'No diagnosis produced',
        docSuggestions: rawSuggestions.map((s: any) =>
          typeof s === 'string' ? { text: s, priority: 50 } : s
        ),
      }
    }
  } catch (err) {
    console.warn(`  [Analyzer] Failed to parse result: ${err}`)
  }

  return { diagnosis: 'Analyzer failed to produce results', docSuggestions: [] }
}

// ---------------------------------------------------------------------------
// Docs writer — applies suggestions from the analyzer
// ---------------------------------------------------------------------------

async function runDocsWriter(
  repoPath: string,
  suggestions: Suggestion[],
  model: string,
): Promise<void> {
  if (suggestions.length === 0) {
    console.log(`  [DocsWriter] No suggestions to apply, skipping.`)
    return
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-docs-'))
  const repoDir = path.join(tempDir, 'repo')

  const sorted = [...suggestions].sort((a, b) => b.priority - a.priority)

  const prompt = `You are a documentation writer for a coding project. Your job is to update the project docs to help AI coding agents build features successfully.

## Suggestions to Apply

Each suggestion has a priority (0-100). Focus on high-priority suggestions (40+). Ignore suggestions with priority below 20 unless they reinforce a pattern you're already documenting.

${sorted.map((s, i) => `${i + 1}. [priority ${s.priority}] ${s.text}`).join('\n')}

## Rules

1. ONLY modify files in docs/, AGENTS.md, or CLAUDE.md. Do NOT modify source code.
2. Each suggestion tells you which file to create or update — follow those instructions.
3. If a suggestion says to update an existing file, make targeted edits rather than rewriting.
4. If multiple suggestions overlap, merge them into one cohesive doc.
5. Keep docs concise and actionable. Dense information beats verbose explanations.
6. Before documenting any function or file path, grep to confirm it exists.
7. Never document aspirational/future behavior — only what exists NOW.
8. Remove or update any existing docs that conflict with the new information.

## Verification

After making changes, read back each modified file to verify it's coherent and accurate.`

  try {
    execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
    const headSha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()
    execSync(`git checkout ${headSha}`, { cwd: repoDir, stdio: 'ignore' })

    syncDocsIntoRepo(repoPath, repoDir)

    const runner = new ClaudeRunner(repoDir, {}, model, 'high')
    await runner.run(prompt)
    syncDocsIntoRepo(repoDir, repoPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  [DocsWriter] Failed: ${msg.slice(0, 200)}`)
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Single rebuild + judge cycle
// ---------------------------------------------------------------------------

async function runRebuildAndJudge(opts: {
  repoPath: string
  feature: CarvedFeature
  groundTruthDiff: string
  round: number
  codingModel: string
  judgeModel: string
  initCommand?: string
}): Promise<{ judging: JudgingResult; diff: string; costEstimate: number }> {
  const { repoPath, feature, groundTruthDiff, round, codingModel, judgeModel, initCommand } = opts

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-perfect-'))
  const repoDir = path.join(tempDir, 'repo')

  try {
    // Clone and carve
    execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
    const headSha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()
    execSync(`git checkout ${headSha}`, { cwd: repoDir, stdio: 'ignore' })
    ensureGitIdentity(repoDir)

    applyCarveOperations(repoDir, feature.operations)
    execSync('git add -A', { cwd: repoDir, stdio: 'ignore' })
    execSync(`git commit -m "carve: remove ${feature.id}" --allow-empty`, { cwd: repoDir, stdio: 'ignore' })

    // Copy docs
    copyDocsIntoRepo(repoPath, repoDir)

    // Init command
    if (initCommand) {
      try {
        execSync(initCommand, { cwd: repoDir, stdio: 'ignore', timeout: 120000 })
      } catch (e) {
        console.warn(`  [Rebuild] Init command failed: ${e}`)
      }
    }

    // Run rebuild agent
    console.log(`  [Rebuild] Round ${round}: Running claude (${codingModel})...`)
    const runner = new ClaudeRunner(repoDir, {}, codingModel, 'medium')
    let result: RunnerResult
    try {
      result = await runner.run(feature.prompt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        judging: {
          analysis: `Agent failed: ${msg.slice(0, 500)}`,
          strengths: [],
          weaknesses: ['Agent failed'],
          e2eTestsPerformed: [],
          completionScore: 0,
          codeQualityScore: 0,
          e2eScore: 0,
          overallScore: 0,
        },
        diff: '',
        costEstimate: 0,
      }
    }

    // Judge
    const judging = await runFlexibleJudge(repoDir, {
      taskPrompt: feature.prompt,
      agentDiff: result.diff,
      groundTruthDiff,
      round,
    }, judgeModel)

    return {
      judging,
      diff: result.diff,
      costEstimate: result.totalCostUsd,
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function perfectFeature(opts: PerfectFeatureOptions): Promise<void> {
  const startTime = new Date().toISOString()
  const baseDir = opts.outputDir ?? path.join(opts.repoPath, '.evalbuff')
  const logDir = path.join(baseDir, `perfect-${opts.featureId}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`)
  fs.mkdirSync(logDir, { recursive: true })

  console.log(`\nPerfect Feature`)
  console.log(`  Repo: ${opts.repoPath}`)
  console.log(`  Feature: ${opts.featureId}`)
  console.log(`  Max rounds: ${opts.maxRounds}`)
  console.log(`  Coding model: ${opts.codingModel}`)
  console.log(`  Judge model: ${opts.judgeModel}`)
  console.log(`  Analyzer model: ${opts.analyzerModel}`)
  console.log(`  Docs model: ${opts.docsModel}`)
  console.log(`  Log dir: ${logDir}`)

  // Load feature
  const allFeatures: CarvedFeature[] = JSON.parse(fs.readFileSync(opts.featuresPath, 'utf-8'))
  const feature = allFeatures.find(f => f.id === opts.featureId)
  if (!feature) {
    const ids = allFeatures.map(f => f.id).join(', ')
    console.error(`Feature "${opts.featureId}" not found. Available: ${ids}`)
    process.exit(1)
  }

  const groundTruthDiff = getGroundTruthDiff(feature)
  fs.writeFileSync(path.join(logDir, 'feature.json'), JSON.stringify(feature, null, 2))
  fs.writeFileSync(path.join(logDir, 'ground-truth.diff'), groundTruthDiff)

  const outcomes: RoundOutcome[] = []
  const diagnoses: string[] = []
  let totalCost = 0
  let bestScore = 0

  for (let round = 0; round < opts.maxRounds; round++) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`ROUND ${round}`)
    console.log(`${'='.repeat(60)}`)

    // Save docs state before this round
    const docsBefore = getDocsSnapshot(opts.repoPath)
    fs.writeFileSync(path.join(logDir, `docs-before-round-${round}.json`), JSON.stringify(docsBefore, null, 2))

    // Run rebuild + judge
    const { judging, diff, costEstimate } = await runRebuildAndJudge({
      repoPath: opts.repoPath,
      feature,
      groundTruthDiff,
      round,
      codingModel: opts.codingModel,
      judgeModel: opts.judgeModel,
      initCommand: opts.initCommand,
    })

    totalCost += costEstimate
    const score = judging.overallScore
    if (score > bestScore) bestScore = score

    console.log(`\n  Score: ${score}/10 (best: ${bestScore}/10)`)
    console.log(`  Strengths: ${judging.strengths.join('; ') || 'none'}`)
    console.log(`  Weaknesses: ${judging.weaknesses.join('; ') || 'none'}`)

    // Save round results
    const roundDir = path.join(logDir, `round-${round}`)
    fs.mkdirSync(roundDir, { recursive: true })
    fs.writeFileSync(path.join(roundDir, 'judging.json'), JSON.stringify(judging, null, 2))
    fs.writeFileSync(path.join(roundDir, 'diff.txt'), diff)
    fs.writeFileSync(path.join(roundDir, 'score.txt'), score.toString())

    // Check for perfection
    if (score >= 10) {
      console.log(`\n  PERFECT SCORE achieved in round ${round}!`)
      outcomes.push({ round, score, judging, diff, diagnosis: '', docsChanged: false, costEstimate })
      break
    }

    // Analyze failure
    const analyzerRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-analyzer-'))
    const analyzerRepo = path.join(analyzerRepoDir, 'repo')
    try {
      execSync(`git clone --no-checkout "${opts.repoPath}" "${analyzerRepo}"`, { stdio: 'ignore' })
      const headSha = execSync('git rev-parse HEAD', { cwd: opts.repoPath, encoding: 'utf-8' }).trim()
      execSync(`git checkout ${headSha}`, { cwd: analyzerRepo, stdio: 'ignore' })
    } catch { /* ignore clone errors */ }

    const analysis = await runAnalyzer(analyzerRepo, {
      taskPrompt: feature.prompt,
      agentDiff: diff,
      groundTruthDiff,
      judging,
      round,
      previousDiagnoses: diagnoses,
      currentDocs: docsBefore,
    }, opts.analyzerModel)

    try {
      fs.rmSync(analyzerRepoDir, { recursive: true, force: true })
    } catch { /* ignore */ }

    diagnoses.push(analysis.diagnosis)
    console.log(`\n  Diagnosis: ${analysis.diagnosis}`)
    console.log(`  Suggestions: ${analysis.docSuggestions.length}`)

    fs.writeFileSync(path.join(roundDir, 'diagnosis.json'), JSON.stringify(analysis, null, 2))

    // Combine analyzer suggestions with judge suggestions
    const allSuggestions = [
      ...analysis.docSuggestions,
      ...(judging.docSuggestions || []),
    ]

    // Apply doc improvements
    let docsChanged = false
    if (allSuggestions.length > 0) {
      console.log(`\n  Applying ${allSuggestions.length} doc suggestions...`)
      await runDocsWriter(opts.repoPath, allSuggestions, opts.docsModel)

      const docsAfter = getDocsSnapshot(opts.repoPath)
      const docsDiff = computeDocsDiffText(docsBefore, docsAfter)
      docsChanged = docsDiff.trim().length > 0

      fs.writeFileSync(path.join(roundDir, 'docs-diff.txt'), docsDiff)
      fs.writeFileSync(path.join(roundDir, 'docs-after.json'), JSON.stringify(docsAfter, null, 2))

      if (docsChanged) {
        console.log(`  Docs updated.`)
      } else {
        console.log(`  Docs writer ran but made no changes.`)
      }
    }

    outcomes.push({ round, score, judging, diff, diagnosis: analysis.diagnosis, docsChanged, costEstimate })

    // If we've been stuck at the same score for 3 rounds, skip ahead in strategy
    if (outcomes.length >= 3) {
      const lastThree = outcomes.slice(-3)
      const allSameScore = lastThree.every(o => o.score === lastThree[0].score)
      if (allSameScore && !docsChanged) {
        console.log(`\n  Stuck at ${score}/10 for 3 rounds. Consider trying a different approach.`)
      }
    }
  }

  // Write final report
  const endTime = new Date().toISOString()
  const finalDocs = getDocsSnapshot(opts.repoPath)
  const report = generateReport(opts, outcomes, totalCost, startTime, endTime, finalDocs)
  fs.writeFileSync(path.join(logDir, 'report.md'), report)

  console.log(`\n${'='.repeat(60)}`)
  console.log('PERFECT FEATURE RUN COMPLETE')
  console.log(`${'='.repeat(60)}`)
  console.log(`  Feature: ${opts.featureId}`)
  console.log(`  Rounds: ${outcomes.length}`)
  console.log(`  Score progression: ${outcomes.map(o => o.score.toFixed(1)).join(' → ')}`)
  console.log(`  Best score: ${bestScore}/10`)
  console.log(`  Total cost: $${totalCost.toFixed(2)}`)
  console.log(`  Log dir: ${logDir}`)
  console.log(`  Report: ${path.join(logDir, 'report.md')}`)
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(
  opts: PerfectFeatureOptions,
  outcomes: RoundOutcome[],
  totalCost: number,
  startTime: string,
  endTime: string,
  finalDocs: Record<string, string>,
): string {
  const L: string[] = []

  L.push('# Perfect Feature Report', '')
  L.push('## Overview', '')
  L.push(`| | |`)
  L.push(`|---|---|`)
  L.push(`| **Feature** | ${opts.featureId} |`)
  L.push(`| **Repo** | \`${opts.repoPath}\` |`)
  L.push(`| **Start** | ${startTime} |`)
  L.push(`| **End** | ${endTime} |`)
  L.push(`| **Rounds** | ${outcomes.length} |`)
  L.push(`| **Best score** | ${Math.max(...outcomes.map(o => o.score))}/10 |`)
  L.push(`| **Total cost** | $${totalCost.toFixed(2)} |`)
  L.push(`| **Coding model** | ${opts.codingModel} |`)
  L.push(`| **Judge model** | ${opts.judgeModel} |`)
  L.push('')

  // Score progression
  L.push('## Score Progression', '')
  L.push('```')
  for (const o of outcomes) {
    const bar = '█'.repeat(Math.round(o.score * 2))
    L.push(`Round ${o.round.toString().padStart(2)}  ${o.score.toFixed(1).padStart(5)}/10  ${bar}`)
  }
  L.push('```', '')

  // Per-round detail
  for (const o of outcomes) {
    L.push(`## Round ${o.round} — ${o.score.toFixed(1)}/10`, '')

    L.push(`| Completion | Code Quality | E2E | Overall |`)
    L.push(`|---|---|---|---|`)
    L.push(`| ${o.judging.completionScore} | ${o.judging.codeQualityScore} | ${o.judging.e2eScore} | ${o.judging.overallScore} |`)
    L.push('')

    L.push(`**Analysis:** ${o.judging.analysis}`, '')

    if (o.judging.strengths.length > 0) {
      L.push('**Strengths:**')
      for (const s of o.judging.strengths) L.push(`- ${s}`)
      L.push('')
    }
    if (o.judging.weaknesses.length > 0) {
      L.push('**Weaknesses:**')
      for (const w of o.judging.weaknesses) L.push(`- ${w}`)
      L.push('')
    }

    if (o.diagnosis) {
      L.push(`**Diagnosis:** ${o.diagnosis}`, '')
    }

    L.push(`**Docs changed:** ${o.docsChanged ? 'Yes' : 'No'}`)
    L.push(`**Cost:** $${o.costEstimate.toFixed(2)}`, '')
  }

  // Final docs
  const docKeys = Object.keys(finalDocs).sort()
  if (docKeys.length > 0) {
    L.push('## Final Documentation', '')
    for (const key of docKeys) {
      L.push(`### ${key}`, '')
      L.push('```markdown')
      L.push(finalDocs[key])
      L.push('```', '')
    }
  }

  return L.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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
  const featuresPath = getArg('features')
  const featureId = getArg('feature-id')
  const maxRounds = parseInt(getArg('max-rounds', '10'))
  const codingModel = getArg('coding-model', 'sonnet')
  const judgeModel = getArg('judge-model', 'opus')
  const analyzerModel = getArg('analyzer-model', 'opus')
  const docsModel = getArg('docs-model', 'opus')
  const initCommand = hasArg('init-command') ? getArg('init-command') : undefined
  const outputDir = hasArg('output-dir') ? getArg('output-dir') : undefined

  perfectFeature({
    repoPath,
    featuresPath,
    featureId,
    maxRounds,
    codingModel,
    judgeModel,
    analyzerModel,
    docsModel,
    initCommand,
    outputDir,
  }).catch((error) => {
    console.error('Perfect feature run failed:', error)
    process.exit(1)
  })
}
