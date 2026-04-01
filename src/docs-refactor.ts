import { ClaudeRunner } from './runners/claude'

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
