import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { z } from 'zod/v4'

import { ClaudeRunner } from './runners/claude'
import { computeDocsDiffText, copyDocsIntoRepo, ensureGitIdentity, getDocsSnapshot, syncDocsIntoRepo } from './eval-helpers'
import { SuggestionSchema } from './judge'

import type { TaskResult } from './eval-runner'
import type { Suggestion } from './judge'

export type SuggestionSource = 'judge' | 'agent' | 'judge+agent'

export interface IndependentSuggestion extends Suggestion {
  source: SuggestionSource
}

export interface CodingAgentSuggestions {
  docSuggestions: Suggestion[]
  projectSuggestions: Suggestion[]
}

export interface DraftedDocsChange {
  tempDir: string
  repoDir: string
  before: Record<string, string>
  after: Record<string, string>
  diffText: string
}

export interface FileChange {
  path: string
  content?: string
  delete?: boolean
}

export interface PlannedDocsChange {
  text: string
  priority: number
  source: SuggestionSource
  accepted: boolean
  reason: string
  overfit: boolean
  fileChanges?: FileChange[]
  diffText?: string
}

export interface PlannedDocsTaskResult {
  tempDir: string
  repoDir: string
  baseCommit: string
  candidates: PlannedDocsChange[]
}

const ALLOWED_DOCS_ROOTS = ['docs/', 'AGENTS.md', 'CLAUDE.md']

function isAllowedDocsPath(relPath: string): boolean {
  const normalized = path.posix.normalize(relPath.replace(/\\/g, '/'))
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false
  return ALLOWED_DOCS_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(root),
  )
}

export const CODING_AGENT_SUGGESTIONS_FILE = 'evalbuff-coding-suggestions.json'
const DOCS_WRITER_PLAN_FILE = 'evalbuff-doc-changes-plan.json'
export const DEFAULT_DOC_SUGGESTION_PRIORITY_FLOOR = 40
const DOCS_WRITER_FAILURE_PREFIX = 'evalbuff-docs-writer-failure-'

const CodingAgentSuggestionsSchema = z.object({
  docSuggestions: z.array(SuggestionSchema).default([]),
  projectSuggestions: z.array(SuggestionSchema).default([]),
})

const DocsWriterPlanEntrySchema = z.object({
  text: z.string(),
  priority: z.number().min(0).max(100),
  source: z.enum(['judge', 'agent', 'judge+agent']),
  accepted: z.boolean(),
  reason: z.string(),
  overfit: z.boolean().default(false),
  scratchDir: z.string().optional(),
  deletedPaths: z.array(z.string()).default([]),
})

const DocsWriterPlanSchema = z.object({
  candidates: z.array(DocsWriterPlanEntrySchema).default([]),
})

function mergeSuggestions(
  entries: Array<{ source: 'judge' | 'agent'; suggestion: Suggestion }>,
): IndependentSuggestion[] {
  const merged = new Map<string, IndependentSuggestion>()

  for (const entry of entries) {
    const key = entry.suggestion.text.trim().toLowerCase()
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, {
        ...entry.suggestion,
        source: entry.source,
      })
      continue
    }

    const nextSource: SuggestionSource =
      existing.source === entry.source ? existing.source : 'judge+agent'

    merged.set(key, {
      text: existing.text,
      priority: Math.max(existing.priority, entry.suggestion.priority),
      source: nextSource,
    })
  }

  return [...merged.values()].sort((a, b) => b.priority - a.priority)
}

export function buildCodingAgentPrompt(taskPrompt: string): string {
  return `${taskPrompt}

After you finish the coding task, write JSON to \`${CODING_AGENT_SUGGESTIONS_FILE}\` in the repo root with this exact shape:

\`\`\`json
{
  "docSuggestions": [
    { "text": "one independent docs change", "priority": 70 }
  ],
  "projectSuggestions": [
    { "text": "one independent project change", "priority": 55 }
  ]
}
\`\`\`

Rules for the suggestions file:
- Each entry must be an independent suggestion that can be implemented on its own.
- \`docSuggestions\` must focus on general documentation changes that would help future coding agents or reviewers succeed on similar tasks.
- \`projectSuggestions\` must describe project changes (source, tests, infra, cleanup), not docs changes.
- Use priorities from 0-100.
- If you have no suggestions for a category, write an empty array for it.
- Write the file as your last action.`
}

export function readCodingAgentSuggestions(repoDir: string): CodingAgentSuggestions {
  const resultPath = path.join(repoDir, CODING_AGENT_SUGGESTIONS_FILE)
  try {
    if (!fs.existsSync(resultPath)) {
      return { docSuggestions: [], projectSuggestions: [] }
    }
    const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
    const parsed = CodingAgentSuggestionsSchema.safeParse(raw)
    if (!parsed.success) {
      return { docSuggestions: [], projectSuggestions: [] }
    }
    return parsed.data
  } catch {
    return { docSuggestions: [], projectSuggestions: [] }
  }
}

export function collectTaskDocSuggestions(task: TaskResult): IndependentSuggestion[] {
  return mergeSuggestions([
    ...(task.judging.docSuggestions || []).map((suggestion) => ({
      source: 'judge' as const,
      suggestion,
    })),
    ...task.agentDocSuggestions.map((suggestion) => ({
      source: 'agent' as const,
      suggestion,
    })),
  ])
}

export function filterDocSuggestionsForPlanning(
  suggestions: IndependentSuggestion[],
  minPriority: number = DEFAULT_DOC_SUGGESTION_PRIORITY_FLOOR,
): IndependentSuggestion[] {
  return suggestions.filter((suggestion) => suggestion.priority >= minPriority)
}

export function renderDocSuggestions(tasks: TaskResult[]): string {
  const sections: string[] = []

  for (const task of tasks) {
    const suggestions = collectTaskDocSuggestions(task)
    if (!suggestions || suggestions.length === 0) continue

    sections.push(
      `### ${task.featureId} (score: ${task.score.toFixed(1)}/10)\n` +
      suggestions.map((s) => `- [${s.source}] [priority ${s.priority}] ${s.text}`).join('\n'),
    )
  }

  return sections.join('\n\n')
}

export function collectProjectSuggestions(tasks: TaskResult[]): string {
  const sections: string[] = []

  for (const task of tasks) {
    const suggestions = mergeSuggestions([
      ...((task.judging.projectSuggestions || []).map((suggestion) => ({
        source: 'judge' as const,
        suggestion,
      }))),
      ...task.agentProjectSuggestions.map((suggestion) => ({
        source: 'agent' as const,
        suggestion,
      })),
    ])
    if (!suggestions || suggestions.length === 0) continue

    sections.push(
      `### ${task.featureId} (score: ${task.score.toFixed(1)}/10)\n` +
      suggestions.map((s) => `- [${s.source}] [priority ${s.priority}] ${s.text}`).join('\n'),
    )
  }

  return sections.join('\n\n')
}

export async function planDocsChangesForTask(
  repoPath: string,
  suggestions: IndependentSuggestion[],
  model: string,
  minPriority: number = DEFAULT_DOC_SUGGESTION_PRIORITY_FLOOR,
): Promise<PlannedDocsTaskResult | null> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-docs-'))
  const repoDir = path.join(tempDir, 'repo')
  let prompt = ''
  let runnerResult: Awaited<ReturnType<ClaudeRunner['run']>> | null = null
  let baseCommit = ''
  let lastError: unknown = null

  function preserveFailure(reason: string): void {
    try {
      const failureDir = fs.mkdtempSync(path.join(os.tmpdir(), DOCS_WRITER_FAILURE_PREFIX))
      fs.writeFileSync(path.join(failureDir, 'reason.txt'), reason)
      fs.writeFileSync(path.join(failureDir, 'prompt.txt'), prompt)
      if (lastError) {
        const errorText = lastError instanceof Error
          ? `${lastError.name}: ${lastError.message}\n${lastError.stack || ''}`.trim()
          : String(lastError)
        fs.writeFileSync(path.join(failureDir, 'error.txt'), errorText + '\n')
      }
      if (runnerResult) {
        fs.writeFileSync(
          path.join(failureDir, 'trace.txt'),
          runnerResult.steps.map((step) => JSON.stringify(step)).join('\n'),
        )
        fs.writeFileSync(path.join(failureDir, 'diff.txt'), runnerResult.diff)
      }
      if (fs.existsSync(repoDir)) {
        fs.renameSync(tempDir, path.join(failureDir, 'workspace'))
      }
      console.error(`Preserved docs-writer failure bundle at ${failureDir}`)
    } catch {
      try {
        cleanupPlannedDocsTaskResult({ tempDir, repoDir, baseCommit, candidates: [] })
      } catch {
        // ignore cleanup failures
      }
    }
  }

  try {
    execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
    const headSha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
    execSync(`git checkout ${headSha}`, { cwd: repoDir, stdio: 'ignore' })
    ensureGitIdentity(repoDir)
    copyDocsIntoRepo(repoPath, repoDir)
    baseCommit = execSync('git rev-parse HEAD', {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim()

    prompt = `Read ALL existing documentation (docs/, AGENTS.md, CLAUDE.md) once, then plan and implement a set of independent candidate documentation changes.

## Candidate Suggestions

${suggestions.length > 0
    ? suggestions.map((suggestion, index) => (
      `${index + 1}. [${suggestion.source}] [priority ${suggestion.priority}] ${suggestion.text}`
    )).join('\n')
    : '(No suggestions were provided)'}

## Required filtering

You must reject a suggestion instead of editing docs when ANY of the following is true:
- It is overfit to just the current task and would not help future unrelated tasks.
- It mainly documents a task-specific fix rather than a reusable project pattern.
- It is already covered by the current docs.
- It is too low priority to justify docs churn. Treat priorities below ${minPriority} as low priority unless the suggestion is clearly critical anyway.
- It would require documenting nonexistent or aspirational behavior.

## Implementation workflow

You will write each accepted candidate's changes into a per-candidate SCRATCH
DIRECTORY. Do NOT modify the real docs/, AGENTS.md, or CLAUDE.md at any point.
Do NOT run any git commands.

1. Read the current docs first.
2. Immediately create \`${DOCS_WRITER_PLAN_FILE}\` in the repo root with one entry per suggestion. Start with every entry marked \`accepted: false\` and a placeholder \`reason\`. Update this file as you make decisions. Do not wait until the end to create it.
3. Evaluate every suggestion and decide whether it should be accepted.
4. For each ACCEPTED suggestion N (N starts at 1):
   - Work inside \`evalbuff-candidates/candidate-N/\`. Mirror the real docs tree there.
   - To MODIFY an existing docs file, first copy it into the scratch dir, then edit the copy. Example for \`docs/patterns/foo.md\`:
     * \`mkdir -p evalbuff-candidates/candidate-N/docs/patterns\`
     * \`cp docs/patterns/foo.md evalbuff-candidates/candidate-N/docs/patterns/foo.md\`
     * edit \`evalbuff-candidates/candidate-N/docs/patterns/foo.md\`
   - To MODIFY \`AGENTS.md\` or \`CLAUDE.md\`, copy to \`evalbuff-candidates/candidate-N/AGENTS.md\` (or \`CLAUDE.md\`) and edit the copy.
   - To CREATE a new file, write it directly at \`evalbuff-candidates/candidate-N/<real-path>\`.
   - To DELETE a file, do NOT delete the real file. Add its path to the candidate's \`deletedPaths\` list in \`${DOCS_WRITER_PLAN_FILE}\`.
   - Record the scratch dir in the plan entry as \`scratchDir: "evalbuff-candidates/candidate-N"\`.
   - Keep the change general, reusable, and not overfit.
5. For each REJECTED suggestion, make no changes and record the rejection reason in \`${DOCS_WRITER_PLAN_FILE}\`.

## Required output shape

\`\`\`json
{
  "candidates": [
    {
      "text": "original suggestion text",
      "priority": 70,
      "source": "judge",
      "accepted": true,
      "reason": "Why this is broadly useful and not overfit",
      "overfit": false,
      "scratchDir": "evalbuff-candidates/candidate-1",
      "deletedPaths": []
    },
    {
      "text": "another suggestion",
      "priority": 20,
      "source": "agent",
      "accepted": false,
      "reason": "Rejected because this is overfit to one task",
      "overfit": true,
      "deletedPaths": []
    }
  ]
}
\`\`\`

Rules:
- ONLY write files under \`evalbuff-candidates/candidate-N/docs/\`, \`evalbuff-candidates/candidate-N/AGENTS.md\`, or \`evalbuff-candidates/candidate-N/CLAUDE.md\`.
- Do NOT modify the real docs/, AGENTS.md, or CLAUDE.md.
- Do NOT modify source code.
- Do NOT run git commands.
- Mirror real file paths EXACTLY under the scratch dir. The relative layout inside \`evalbuff-candidates/candidate-N/\` must match where the files live in the repo.
- Each candidate's scratch dir must stand on its own. Do not share files between candidates — if two candidates both touch \`AGENTS.md\`, each candidate copies it into its own scratch dir independently.
- Keep AGENTS.md changes limited to doc-index maintenance or factual corrections.
- Verify referenced helpers, scripts, file paths, and symbols against the codebase before documenting them.
- Do not document aspirational behavior.
- If all suggestions are rejected, still write the JSON file with every rejection recorded.
- The \`reason\` field must explicitly say why a rejected suggestion is overfit or low value when that applies.`

    const runner = new ClaudeRunner(repoDir, {}, model, 'high')
    runnerResult = await runner.run(prompt)

    const planPath = path.join(repoDir, DOCS_WRITER_PLAN_FILE)
    if (!fs.existsSync(planPath)) {
      preserveFailure('Missing evalbuff-doc-changes-plan.json after docs-writer run')
      return null
    }

    const raw = JSON.parse(fs.readFileSync(planPath, 'utf-8'))
    const parsed = DocsWriterPlanSchema.safeParse(raw)
    if (!parsed.success) {
      preserveFailure('Invalid evalbuff-doc-changes-plan.json shape')
      return null
    }

    const candidates: PlannedDocsChange[] = []
    for (const entry of parsed.data.candidates) {
      const planned: PlannedDocsChange = {
        text: entry.text,
        priority: entry.priority,
        source: entry.source,
        accepted: entry.accepted,
        reason: entry.reason,
        overfit: entry.overfit,
      }

      if (entry.accepted) {
        const fileChanges = buildFileChangesFromScratch(
          repoDir,
          entry.scratchDir,
          entry.deletedPaths,
        )
        if (fileChanges.length === 0) {
          planned.accepted = false
          planned.reason = `Rejected because the docs writer produced no scratch-dir files for this candidate: ${planned.reason}`
        } else {
          planned.fileChanges = fileChanges
          const before = getDocsSnapshot(repoPath)
          const after = applyFileChangesToSnapshot(before, fileChanges)
          planned.diffText = computeDocsDiffText(before, after)
        }
      }

      candidates.push(planned)
    }

    return { tempDir, repoDir, baseCommit, candidates }
  } catch (error) {
    lastError = error
    preserveFailure('Unhandled exception while planning docs changes')
    return null
  }
}

export function cleanupPlannedDocsTaskResult(result: PlannedDocsTaskResult): void {
  try {
    fs.rmSync(result.tempDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup failures
  }
}

function buildFileChangesFromScratch(
  repoDir: string,
  scratchDir: string | undefined,
  deletedPaths: string[],
): FileChange[] {
  const changes: FileChange[] = []
  const seen = new Set<string>()

  if (scratchDir) {
    const scratchRoot = path.join(repoDir, scratchDir)
    if (fs.existsSync(scratchRoot) && fs.statSync(scratchRoot).isDirectory()) {
      const walk = (dir: string, prefix: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name)
          const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name
          if (entry.isDirectory()) {
            walk(fullPath, rel)
          } else if (entry.isFile()) {
            if (!isAllowedDocsPath(rel)) continue
            const content = fs.readFileSync(fullPath, 'utf-8')
            changes.push({ path: rel, content })
            seen.add(rel)
          }
        }
      }
      walk(scratchRoot, '')
    }
  }

  for (const p of deletedPaths) {
    const normalized = path.posix.normalize(p.replace(/\\/g, '/'))
    if (!isAllowedDocsPath(normalized) || seen.has(normalized)) continue
    changes.push({ path: normalized, delete: true })
    seen.add(normalized)
  }

  return changes
}

function applyFileChangesToSnapshot(
  before: Record<string, string>,
  fileChanges: FileChange[],
): Record<string, string> {
  const after: Record<string, string> = { ...before }
  for (const change of fileChanges) {
    if (change.delete) {
      delete after[change.path]
    } else if (change.content !== undefined) {
      after[change.path] = change.content
    }
  }
  return after
}

export function materializeDocsChange(
  repoPath: string,
  fileChanges: FileChange[],
): DraftedDocsChange | null {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-docs-materialized-'))
  const repoDir = path.join(tempDir, 'repo')

  try {
    execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
    const headSha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
    execSync(`git checkout ${headSha}`, { cwd: repoDir, stdio: 'ignore' })
    ensureGitIdentity(repoDir)
    copyDocsIntoRepo(repoPath, repoDir)

    const before = getDocsSnapshot(repoDir)

    for (const change of fileChanges) {
      if (!isAllowedDocsPath(change.path)) continue
      const fullPath = path.join(repoDir, change.path)
      if (change.delete) {
        try {
          fs.rmSync(fullPath, { force: true })
        } catch {
          // ignore
        }
      } else if (change.content !== undefined) {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true })
        fs.writeFileSync(fullPath, change.content)
      }
    }

    const after = getDocsSnapshot(repoDir)
    const diffText = computeDocsDiffText(before, after)
    return { tempDir, repoDir, before, after, diffText }
  } catch {
    cleanupDraftedDocsChange({ tempDir, repoDir, before: {}, after: {}, diffText: '' })
    return null
  }
}

export function acceptDraftedDocsChange(
  repoPath: string,
  draft: DraftedDocsChange,
): string[] {
  try {
    return syncDocsIntoRepo(draft.repoDir, repoPath)
  } finally {
    cleanupDraftedDocsChange(draft)
  }
}

export function cleanupDraftedDocsChange(draft: DraftedDocsChange): void {
  try {
    fs.rmSync(draft.tempDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup failures
  }
}

const PROMPT_WRITER_RESULT_FILE = 'evalbuff-project-prompts.json'

export async function runPromptWriterAgent(
  repoPath: string,
  allProjectSuggestions: string,
  model: string,
): Promise<string[]> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-prompts-'))
  const repoDir = path.join(tempDir, 'repo')

  const prompt = `You are a senior engineer who has been given a set of project improvement suggestions collected from multiple code review sessions. Your job is to consolidate these into a set of clear, independent prompts that another coding agent could follow to improve the project.

## Context

An automated evaluation system ran a coding agent on multiple tasks in this repository, and judges reviewed the results. Along with documentation suggestions, the judges also identified ways the **project itself** could be improved — refactors, dead code removal, test infrastructure, dependency cleanup, environment fixes, or new features.

Below are ALL the raw project suggestions collected across all evaluation rounds. Each is tagged with a priority score (0-100) from the judge that created it. Higher priority means more impactful.

## Raw Project Suggestions

${allProjectSuggestions || '(No suggestions were collected)'}

## Your Task

1. **Read the codebase** to understand the project structure and verify which suggestions are actionable.
2. **Consolidate** similar or overlapping suggestions into single prompts. Multiple judges flagging the same issue from different angles is a strong signal — treat repeated suggestions as having higher effective priority.
3. **Discard** suggestions that are no longer relevant (the issue was already fixed, the file doesn't exist, etc.).
4. **Ignore low-priority suggestions** — skip suggestions with priority below 20 unless they appeared multiple times across features. Focus your effort on the high-impact changes.
5. **Write clear prompts** — each prompt should be a self-contained description of one change that a coding agent could implement independently, without needing context from other prompts.
6. **Prioritize** by impact — put the most impactful changes first, using the priority scores as a guide.

Each prompt should include:
- A clear title/summary of the change
- What files/modules are affected
- What the current state is and what's wrong with it
- What the desired end state looks like
- Any specific implementation guidance

Write the result as a JSON array of strings to \`${PROMPT_WRITER_RESULT_FILE}\` in the current directory. Each string is one complete prompt.

Example output format:
\`\`\`json
[
  "Title: Consolidate error handling utilities\\n\\nCurrently src/middleware/error.ts and src/utils/errors.ts both define error formatting logic, which confuses agents about which to import.\\n\\nChange: Move all error utilities into src/utils/errors.ts. Update src/middleware/error.ts to re-export from utils. Update all imports across the codebase.\\n\\nEnd state: One canonical location for error handling (src/utils/errors.ts), with the middleware file being a thin re-export layer.",
  "Title: Add integration test harness for API routes\\n\\nCurrently there's no way to test API routes end-to-end without manually starting the dev server.\\n\\nChange: Create tests/helpers/server.ts that exports a startTestServer() function which starts the app on a random port, seeds test data, and returns { url, cleanup }. Add one example test in tests/integration/routes.test.ts that uses it.\\n\\nEnd state: Agents and reviewers can run 'bun test tests/integration/' to verify route changes work end-to-end."
]
\`\`\`

If no suggestions are actionable after verification, write an empty array \`[]\`.

IMPORTANT: You MUST write the result file. This is the only output that gets captured.`

  try {
    execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
    const headSha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
    execSync(`git checkout ${headSha}`, { cwd: repoDir, stdio: 'ignore' })

    const runner = new ClaudeRunner(repoDir, {}, model, 'high')
    await runner.run(prompt)

    // Read the result file
    const resultPath = path.join(repoDir, PROMPT_WRITER_RESULT_FILE)
    if (fs.existsSync(resultPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
        if (Array.isArray(parsed)) {
          return parsed.filter((p): p is string => typeof p === 'string')
        }
      } catch {
        // Parse failure — return empty
      }
    } else {
    }
    return []
  } catch {
    return []
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }
}
