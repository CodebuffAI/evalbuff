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
      suggestions.map((s) => `- ${s}`).join('\n'),
    )
  }

  return sections.join('\n\n')
}

export async function runDocsRefactorAgent(
  repoPath: string,
  judgeSuggestions: string,
  model: string,
): Promise<void> {
  console.log(`\n  [DocsRefactor] Running holistic docs refactor...`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalbuff-docs-'))
  const repoDir = path.join(tempDir, 'repo')

  const prompt = `Read ALL existing documentation (docs/, AGENTS.md, CLAUDE.md), consider the judge suggestions below, and make the documentation as useful as possible for coding agents.

## Goal

The purpose of these docs is to help a coding agent successfully build NEW features it has never seen before. The docs should teach the agent how the project works — its architecture, patterns, conventions, and rules — so it can confidently build anything, not just reconstruct specific existing features.

## Judge Suggestions

Multiple judge agents reviewed coding agent attempts and identified documentation gaps. Here are their suggestions:

${judgeSuggestions || '(No suggestions were made)'}

## What to do

1. **Extract general patterns** — each judge suggestion reflects a specific failure, but your job is to identify the underlying pattern or convention that would prevent a whole class of similar failures. Ask: "What general rule would help an agent get this right for ANY feature?"
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
    console.warn(`  [DocsRefactor] Failed: ${msg.slice(0, 200)}`)
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }
}
