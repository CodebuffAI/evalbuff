/**
 * Feature Carver for evalbuff v2.
 *
 * Uses Codex agents to:
 * 1. Analyze a codebase to identify discrete, self-contained features
 * 2. Carve each feature out in an isolated git worktree, running typecheck/tests to verify
 * 3. Capture the real git diff as the ground truth
 */
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import { Codex } from '@openai/codex-sdk'

// --- Types ---

export interface CarveCandidate {
  id: string
  name: string
  prompt: string
  description: string
  files: string[]
  relevantFiles: string[]
  complexity: 'small' | 'medium' | 'large'
}

export interface CarvePlan {
  candidates: CarveCandidate[]
  reasoning: string
}

export interface FileOperation {
  path: string
  action: 'delete' | 'modify'
  newContent?: string
}

export interface CarvedFeature {
  id: string
  prompt: string
  description: string
  complexity: 'small' | 'medium' | 'large'
  /** Files as they exist before carving (the "ground truth" to rebuild) */
  originalFiles: Record<string, string>
  /** Operations to perform to carve the feature out */
  operations: FileOperation[]
  /** Unified diff of the carving (from git diff) */
  diff: string
}

export interface CarveResult {
  repoPath: string
  generationDate: string
  features: CarvedFeature[]
}

// --- Constants ---

const RESULT_FILE = 'evalbuff-carve-result.json'

// --- Phase 1: Identify features to carve (Codex agent) ---

export async function planFeatures(repoPath: string): Promise<CarvePlan> {
  const codex = new Codex({
    apiKey: process.env.OPENAI_API_KEY,
  })

  const thread = codex.startThread({
    model: 'gpt-5.4',
    workingDirectory: repoPath,
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    webSearchMode: 'live',
    modelReasoningEffort: 'high',
  })

  const prompt = `You are an expert software architect. Analyze this codebase to identify 15-25 discrete, self-contained features that can be cleanly "carved out" (deleted) and used as coding evaluation tasks.

Explore the codebase thoroughly — read the file tree, key config files, entry points, and source files to understand the architecture.

## What makes a GOOD carve candidate

- A React component + its usage sites + unit tests + docs
- An API endpoint (route + handler + types + unit tests + docs)
- A CLI subcommand or flag
- A utility module used in a few places
- A feature behind a config/flag including tests and docs
- A test suite for a specific module
- A middleware or plugin
- An integration with an external service

Each feature should:
1. Be self-contained — removing it leaves the rest of the codebase functional
2. Be describable in 1-2 sentences — a developer could ask for it naturally
3. Be non-trivial but bounded — not a one-liner, but not "rewrite the whole app"
4. Not overlap with other candidates

## What makes a BAD candidate

- Core infrastructure that everything depends on (routing, auth framework, database connection)
- A single function that's called in 50 places
- Trivially small changes (rename, config tweak)
- Auto-generated or boilerplate code

## Output

After your analysis, write a file called \`${RESULT_FILE}\` with this JSON structure:

\`\`\`json
{
  "reasoning": "Your analysis of the codebase and approach to selecting features",
  "candidates": [
    {
      "id": "short-kebab-id",
      "name": "Human readable name",
      "prompt": "Natural prompt a developer would use to ask for this feature, 1-2 sentences",
      "description": "What this feature does and why it exists",
      "files": ["path/to/file1.ts", "path/to/file2.tsx"],
      "relevantFiles": ["path/to/importer.ts"],
      "complexity": "small|medium|large"
    }
  ]
}
\`\`\`

- **files**: The files that ARE the feature (to be deleted or modified to remove it). Be thorough — missing a file means the carve won't be clean.
- **relevantFiles**: Other files that import or reference the feature.

You MUST write the result file as your last action.`

  const result = await thread.run(prompt)

  // Read the result file
  const resultPath = path.join(repoPath, RESULT_FILE)
  if (!fs.existsSync(resultPath)) {
    // Try to extract from the agent's final response
    const jsonMatch = result.finalResponse.match(/\{[\s\S]*"candidates"[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as CarvePlan
    }
    throw new Error('Codex agent did not produce a result file')
  }

  try {
    const raw = fs.readFileSync(resultPath, 'utf-8')
    return JSON.parse(raw) as CarvePlan
  } finally {
    fs.rmSync(resultPath, { force: true })
  }
}

// --- Phase 2: Carve a feature in an isolated worktree ---

export async function carveFeature(
  repoPath: string,
  candidate: CarveCandidate,
): Promise<CarvedFeature | null> {
  // Save original files before carving
  const originalFiles: Record<string, string> = {}
  for (const filePath of candidate.files) {
    const fullPath = path.join(repoPath, filePath)
    if (fs.existsSync(fullPath)) {
      originalFiles[filePath] = fs.readFileSync(fullPath, 'utf-8')
    }
  }

  // Create a git worktree for isolated carving
  const worktreePath = `${repoPath}-carve-${candidate.id}`
  const branchName = `evalbuff-carve-${candidate.id}-${Date.now()}`

  try {
    execSync(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, {
      cwd: repoPath,
      stdio: 'ignore',
    })

    // Run the Codex agent in the worktree to carve the feature
    const codex = new Codex({
      apiKey: process.env.OPENAI_API_KEY,
    })

    const thread = codex.startThread({
      model: 'gpt-5.4',
      workingDirectory: worktreePath,
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      webSearchMode: 'live',
      modelReasoningEffort: 'high',
    })

    const prompt = `You are a precise code surgeon. Your job is to cleanly remove the following feature from this codebase.

## Feature to Remove
**Name:** ${candidate.name}
**Description:** ${candidate.description}

**Feature files (to delete or modify):** ${candidate.files.join(', ')}
**Other relevant files to check for references:** ${candidate.relevantFiles?.join(', ') || '(none)'}

## Rules

1. **Delete completely** — remove ALL code related to the feature: components, handlers, types, tests, docs, imports, route registrations, etc.
2. **Don't break the rest** — the remaining code must still compile and pass tests. Fix imports, remove dead references, etc.
3. **Minimal collateral** — only remove what's necessary. Don't "improve" or refactor surrounding code.
4. **Be thorough** — search for references in other files. If file A imports something from the feature, update file A's imports.
5. **Verify your work** — after making changes, run the typecheck command (check package.json for the right command, typically \`tsc --noEmit\` or \`npx tsc --noEmit\`). Fix any errors that result from your changes. Also run the test suite if one exists.

## Process

1. Read the feature files and understand what to remove
2. Search for all references/imports of the feature across the codebase
3. Delete feature-only files, edit shared files to remove feature code
4. Run typecheck and fix any compilation errors
5. Run tests if available and fix any failures caused by the removal (remove tests for the deleted feature, fix tests that referenced it)

Do NOT create any result files — just make the edits directly.`

    await thread.run(prompt)

    // Capture the diff
    execSync('git add -A', { cwd: worktreePath, stdio: 'ignore' })
    const diff = execSync('git diff --cached HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })

    if (!diff.trim()) {
      return null
    }

    // Build operations from the actual git diff
    const operations = buildOperationsFromDiff(worktreePath, repoPath, candidate.files)

    return {
      id: candidate.id,
      prompt: candidate.prompt,
      description: candidate.description,
      complexity: candidate.complexity,
      originalFiles,
      operations,
      diff,
    }
  } catch {
    return null
  } finally {
    // Clean up worktree and branch
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: repoPath,
        stdio: 'ignore',
      })
    } catch { /* ignore */ }
    try {
      execSync(`git branch -D "${branchName}"`, {
        cwd: repoPath,
        stdio: 'ignore',
      })
    } catch { /* ignore */ }
  }
}

/**
 * Build FileOperation[] by comparing worktree state against the original repo.
 */
function buildOperationsFromDiff(
  worktreePath: string,
  repoPath: string,
  featureFiles: string[],
): FileOperation[] {
  const operations: FileOperation[] = []

  // Get list of changed files from git
  const statusOutput = execSync('git diff --cached --name-status HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
  })

  for (const line of statusOutput.trim().split('\n')) {
    if (!line.trim()) continue
    const [status, ...pathParts] = line.split('\t')
    const filePath = pathParts.join('\t')

    if (status === 'D') {
      operations.push({ path: filePath, action: 'delete' })
    } else if (status === 'M' || status === 'A') {
      const newContent = fs.readFileSync(path.join(worktreePath, filePath), 'utf-8')
      operations.push({ path: filePath, action: 'modify', newContent })
    }
  }

  return operations
}

// --- Main orchestrator ---

export async function carveFeatures(
  repoPath: string,
  options: {
    count?: number
    outputPath?: string
  } = {},
): Promise<CarveResult> {
  const { count = 10, outputPath } = options

  console.log(`Carving features from: ${repoPath} (target: ${count})`)

  // Phase 1: Plan
  const plan = await planFeatures(repoPath)
  console.log(`Found ${plan.candidates.length} candidates`)

  // Select top N candidates (prefer medium complexity)
  const ranked = [...plan.candidates].sort((a, b) => {
    const complexityOrder = { medium: 0, small: 1, large: 2 }
    return complexityOrder[a.complexity] - complexityOrder[b.complexity]
  })
  const selected = ranked.slice(0, count)

  // Phase 2: Carve each feature
  const features: CarvedFeature[] = []
  for (const candidate of selected) {
    const carved = await carveFeature(repoPath, candidate)
    if (carved) {
      features.push(carved)
    }
  }
  console.log(`Carved ${features.length}/${selected.length} features`)

  const result: CarveResult = {
    repoPath,
    generationDate: new Date().toISOString(),
    features,
  }

  // Save output
  const outPath =
    outputPath ||
    path.join(repoPath, `carve-${new Date().toISOString().slice(0, 10)}.json`)
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\nSaved ${features.length} carved features to: ${outPath}`)

  return result
}

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2)

  const getArg = (name: string, defaultValue?: string): string => {
    const idx = args.indexOf(`--${name}`)
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`Missing required argument: --${name}`)
  }

  const repoPath = getArg('repo')
  const count = parseInt(getArg('count', '10'))
  const outputPath = args.indexOf('--output') >= 0 ? getArg('output') : undefined

  carveFeatures(repoPath, { count, outputPath })
    .then((result) => {
      console.log(`\nDone! Carved ${result.features.length} features.`)
    })
    .catch((error) => {
      console.error('Carving failed:', error)
      process.exit(1)
    })
}
