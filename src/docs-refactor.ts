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
- Be specific about file paths, directory structure, and conventions — but generic about what gets built.`

  try {
    const runner = new ClaudeRunner(repoPath, {}, model, 'high')
    await runner.run(prompt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  [DocsRefactor] Failed: ${msg.slice(0, 200)}`)
  }
}
