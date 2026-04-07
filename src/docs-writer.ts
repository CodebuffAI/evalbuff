import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { ClaudeRunner } from './runners/claude'
import { syncDocsIntoRepo } from './eval-helpers'

import type { TaskResult } from './eval-runner'

export function collectDocSuggestions(tasks: TaskResult[]): string {
  const sections: string[] = []

  for (const task of tasks) {
    const suggestions = task.judging.docSuggestions
    if (!suggestions || suggestions.length === 0) continue

    sections.push(
      `### ${task.featureId} (score: ${task.score.toFixed(1)}/10)\n` +
      suggestions.map((s) => `- [priority ${s.priority}] ${s.text}`).join('\n'),
    )
  }

  return sections.join('\n\n')
}

export function collectProjectSuggestions(tasks: TaskResult[]): string {
  const sections: string[] = []

  for (const task of tasks) {
    const suggestions = task.judging.projectSuggestions
    if (!suggestions || suggestions.length === 0) continue

    sections.push(
      `### ${task.featureId} (score: ${task.score.toFixed(1)}/10)\n` +
      suggestions.map((s) => `- [priority ${s.priority}] ${s.text}`).join('\n'),
    )
  }

  return sections.join('\n\n')
}

export async function runDocsWriterAgent(
  repoPath: string,
  judgeSuggestions: string,
  model: string,
): Promise<void> {
  console.log(`\n  [DocsWriter] Running docs writer agent...`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-docs-'))
  const repoDir = path.join(tempDir, 'repo')

  const prompt = `Read ALL existing documentation (docs/, AGENTS.md, CLAUDE.md), consider the judge suggestions below, and make the documentation as useful as possible for coding agents.

## Goal

The purpose of these docs is to help a coding agent successfully build NEW features it has never seen before, AND to help reviewers verify that changes actually work. The docs should teach the agent how the project works — its architecture, patterns, conventions, and rules — so it can confidently build anything, not just reconstruct specific existing features. They should also document testing strategies, verification processes, and end-to-end testing approaches that help reviewers evaluate changes beyond just reading the diff.

## Judge Suggestions

Multiple judge agents reviewed coding agent attempts and identified documentation gaps. Here are their suggestions, each tagged with a priority score (0-100). Higher priority means more impactful. When the same suggestion appears multiple times across features, that's a signal it deserves higher effective priority.

**Focus on suggestions with priority 40+. Ignore suggestions with priority below 20 unless they appear multiple times.** Low-priority suggestions are minor nice-to-haves that aren't worth the docs clutter.

${judgeSuggestions || '(No suggestions were made)'}

## What to do

1. **Extract general patterns** — each judge suggestion reflects a specific failure, but your job is to identify the underlying pattern or convention that would prevent a whole class of similar failures. Ask: "What general rule would help an agent get this right for ANY feature?" Some suggestions are about testing/verification strategies for reviewers — treat those as equally important and document them in the appropriate docs (e.g., docs/testing.md or similar).
2. **Do NOT reference specific features** — never mention a specific feature, component, or endpoint by name as an example of what to build. Instead, document the pattern it follows. For example, instead of "the UserProfile component fetches data in useEffect", write "components in this project fetch data using useEffect on mount, following the pattern in src/hooks/".
3. **Document architecture and data flow** — describe how the project is structured, how data flows through it, and where new code should be placed. These are the things an agent building something new needs most.
4. **Edit existing docs** — when a suggestion maps to an existing doc, make fine-grained edits rather than rewriting from scratch.
5. **Create new docs** — when a suggestion identifies a missing pattern or convention, create a concise new doc for it.
6. **Merge overlapping docs** — if multiple suggestions or existing docs cover similar topics, combine them.
7. **Remove redundancy** — consolidate duplicate advice. Dense, actionable information beats verbose explanations.
8. **Fix contradictions** — if docs disagree, pick the correct advice and remove the wrong one.
9. **Prune stale docs** — remove docs that reference files/patterns that no longer exist in the codebase.

Rules:
- ONLY modify files in docs/, AGENTS.md, or CLAUDE.md. Do NOT modify source code.
- **Do NOT edit AGENTS.md beyond adding new docs to its index.** The only allowed changes to AGENTS.md are: (a) adding/removing entries in the doc index when you create or delete files under docs/, and (b) correcting existing information that is factually wrong. Do NOT add new paragraphs, prose, sections, or explanatory text above or below existing content. Put all new guidance in docs/ files and link to them from the index.
- It's OK to delete doc files that are redundant or low-value.
- The goal is a minimal, high-signal set of docs that a coding agent can use to build ANY feature, including ones that don't exist yet.
- Less is more — 5 great docs are better than 15 mediocre ones.
- Document patterns, conventions, and architectural rules — not specific feature implementations.
- Be specific about file paths, directory structure, and conventions — but generic about what gets built.

## Docs Must Match Source Code

Docs that describe nonexistent code are WORSE than no docs at all — they actively mislead coding agents and cause them to fail.

Before writing any doc that references a helper, function, type, or script:
1. **grep for the exact symbol name** to confirm it exists. If it doesn't exist, DO NOT document it.
2. **Never document aspirational/future behavior.** Only document what the code does RIGHT NOW.
3. **If a judge suggestion references a helper that doesn't exist**, document the PATTERN the agent should follow instead — not a fictional API.

Wrong: "Use \`captureGitDiff()\` from src/eval-helpers.ts to capture diffs"  (if it doesn't exist)
Right: "Diff capture should use an explicit base SHA recorded before the agent runs"  (describes the pattern)

## Final Step: Spawn a Critique Sub-Agent

Before you finish, you MUST spawn a critique sub-agent via the Task tool (subagent_type: "general-purpose") to review the docs you just wrote or modified. Then apply every valid fix it identifies.

Use this exact prompt for the sub-agent:

---
You are a documentation critic. Review every file under docs/, plus AGENTS.md and CLAUDE.md, and report violations of the rules below. For each violation, give the file path, the offending text or line range, and a concrete fix (exact replacement text, the section to remove, or the split to perform).

Rules (enforce strictly):

1. **No overfitting to a single task.** Docs must describe general patterns, conventions, and architecture that apply to building ANY feature — not one specific task. Flag:
   - Feature-specific function, type, component, endpoint, table, or CLI-subcommand names that only matter for one task and are not shared infrastructure.
   - Examples phrased around one feature ("the UserProfile component fetches data via useEffect") instead of the general pattern ("components in src/components/ fetch data in useEffect on mount").
   - Any symbol reference that does not represent a shared utility, pattern, or architectural boundary used by multiple features.
   The fix is to rewrite the passage as a general rule about the pattern, directory, or convention — or delete it if it does not generalize.

2. **No code excerpts unless documenting a common utility or shared pattern.** A code block is only allowed when it shows:
   - The signature or usage of a shared helper multiple features rely on, OR
   - A canonical pattern every agent should copy (error handling, a standard import shape, etc.).
   Flag any code block that shows task-specific implementation details. The fix is to delete the block or replace it with a one-line prose description of the pattern.

3. **Individual markdown files must stay focused and reasonably short.** If any single file exceeds roughly 300 lines, OR covers multiple unrelated topics, recommend splitting it into smaller topic-scoped files and specify the split (new filenames + which sections move where). Prefer many small focused docs over one large doc.

4. **Docs must match source code.** Before flagging a missing symbol, grep the repo to confirm it does not exist. Flag references to helpers, functions, types, files, or scripts that are not present in the code.

Return a numbered list of violations with fixes. If a file is clean, say so. Do not edit any files yourself — only report.
---

After the sub-agent returns, apply every valid fix it identified by editing the doc files directly. If it recommended splitting a long doc, perform the split. Re-read each affected file after fixing to confirm the result. Only then finish.`

  try {
    execSync(`git clone --no-checkout "${repoPath}" "${repoDir}"`, { stdio: 'ignore' })
    const headSha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim()
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
    } catch {
      // ignore cleanup failures
    }
  }
}

const PROMPT_WRITER_RESULT_FILE = 'evalbuff-project-prompts.json'

export async function runPromptWriterAgent(
  repoPath: string,
  allProjectSuggestions: string,
  model: string,
): Promise<string[]> {
  console.log(`\n  [PromptWriter] Running prompt writer agent...`)
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
          console.log(`  [PromptWriter] Generated ${parsed.length} project improvement prompts`)
          return parsed.filter((p): p is string => typeof p === 'string')
        }
      } catch (parseErr) {
        console.warn(`  [PromptWriter] Failed to parse result: ${parseErr}`)
      }
    } else {
      console.warn(`  [PromptWriter] No result file written`)
    }
    return []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  [PromptWriter] Failed: ${msg.slice(0, 200)}`)
    return []
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }
}
