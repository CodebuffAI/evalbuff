import fs from 'fs'
import path from 'path'

import { Codex } from '@openai/codex-sdk'
import { z } from 'zod/v4'

import { truncateDiff } from './eval-helpers'


export const SuggestionSchema = z.object({
  text: z.string().describe('The suggestion content'),
  priority: z
    .number()
    .min(0)
    .max(100)
    .describe(
      'Priority from 0 (totally unnecessary) to 100 (extremely impactful and urgent)'
    ),
})

export type Suggestion = z.infer<typeof SuggestionSchema>

export const JudgingResultSchema = z.object({
  analysis: z
    .string()
    .describe('Detailed analysis of what was tested and found'),
  strengths: z
    .array(z.string())
    .describe('Key strengths of the implementation'),
  weaknesses: z.array(z.string()).describe('Key weaknesses or issues found'),
  e2eTestsPerformed: z
    .array(z.string())
    .describe('List of E2E tests that were actually performed'),
  completionScore: z
    .number()
    .min(0)
    .max(10)
    .describe('How completely the prompt was addressed'),
  codeQualityScore: z
    .number()
    .min(0)
    .max(10)
    .describe('Code structure and maintainability'),
  e2eScore: z
    .number()
    .min(0)
    .max(10)
    .describe('How well the change works when tested end-to-end'),
  overallScore: z.number().min(0).max(10).describe('Combined assessment'),
  docSuggestions: z
    .array(SuggestionSchema)
    .optional()
    .describe(
      'Recommendations for documentation changes to help future coding agents AND future reviewers, each with a priority score'
    ),
  projectSuggestions: z
    .array(SuggestionSchema)
    .optional()
    .describe(
      'Suggestions for improving the project itself — refactors, dead code removal, test infrastructure, dependency cleanup, or new features — each with a priority score'
    ),
})

export type JudgingResult = z.infer<typeof JudgingResultSchema>

const RESULT_FILE_NAME = 'evalbuff-review-result.json'

function buildReviewerPrompt(input: {
  taskPrompt: string
  agentDiff: string
  groundTruthDiff?: string
  error?: string
  docsDir?: string
}): string {
  const { taskPrompt, agentDiff: rawAgentDiff, groundTruthDiff: rawGroundTruthDiff, error, docsDir } = input
  const agentDiff = truncateDiff(rawAgentDiff)
  const groundTruthDiff = rawGroundTruthDiff ? truncateDiff(rawGroundTruthDiff) : rawGroundTruthDiff

  const groundTruth = groundTruthDiff
    ? `## Ground Truth Changes (One valid implementation)
${groundTruthDiff}`
    : `## Ground Truth
No reference implementation is available. You must judge the agent's work solely by testing it end-to-end. Focus heavily on:
- Does it build and run?
- Does the feature actually work when you test it?
- Are there errors in the logs?
- Does it handle edge cases?`

  const docsSection = docsDir
    ? `\n## Project Docs\nRead the docs in the \`docs/\` directory and \`AGENTS.md\` for project-specific patterns and conventions before reviewing.\n`
    : ''

  return `You are a senior engineer performing a thorough code review with E2E testing.

## Your Mission

You have been given a coding task and an AI agent's attempt. Your job is to:

1. **Read the project docs** (if present) to understand conventions and patterns
2. **Review the agent's diff** ${groundTruthDiff ? 'against the ground truth' : 'for correctness and completeness'}
3. **Actually test the changes** end-to-end:
   - Start the application if possible (check package.json for start/dev scripts)
   - Use browser tools, curl, or the appropriate client to exercise the feature
   - Check logs for errors
   - Test edge cases and error states
   - Take screenshots of UI changes if applicable
4. **Write your judgment** to a JSON file

## Important: You have full access to the repository and can run any commands.

Use whatever tools you need to verify the change actually works:
- Run the build/compile step
- Run the test suite
- Start the dev server
- Use browser tools to test the UI
- curl API endpoints
- Check logs
- Use tmux for long-running processes
- Any other verification method appropriate for the change

${docsSection}
## User Prompt (What the agent was asked to do)
${taskPrompt}

${groundTruth}

## Agent's Changes (What the agent actually did)
\`\`\`diff
${agentDiff || '(No changes made)'}
\`\`\`
${error ? `\n## Error Encountered During Agent Run\n${error}\n` : ''}

## Required Output

After your review and testing, write your judgment to the file \`${RESULT_FILE_NAME}\` in the current working directory. The JSON must have exactly this structure:

\`\`\`json
{
  "analysis": "Detailed analysis of what you tested and found...",
  "strengths": ["strength 1", "strength 2"],
  "weaknesses": ["weakness 1", "weakness 2"],
  "e2eTestsPerformed": ["Started dev server and loaded /dashboard", "Submitted form with invalid email", "Checked network tab for API errors"],
  "completionScore": 7,
  "codeQualityScore": 8,
  "e2eScore": 6,
  "overallScore": 7,
  "docSuggestions": [
    { "text": "Update docs/architecture.md: Add a section 'Route Registration'. All API routes must be registered in src/routes/index.ts by calling registerRoute(). The route handler file goes in src/routes/<name>.ts and must export a default function with signature (req: Request, res: Response) => void. Without registration the route silently 404s — there is no auto-discovery.", "priority": 85 },
    { "text": "Create docs/patterns/error-handling.md: All async route handlers in src/routes/ must be wrapped with withErrorHandler() from src/middleware/error.ts. This wrapper catches thrown errors and returns a standardized { error: string, code: number } JSON response. Without it, unhandled rejections crash the server. Example: export default withErrorHandler(async (req, res) => { ... })", "priority": 70 }
  ],
  "projectSuggestions": [
    { "text": "Refactor: The error handling middleware in src/middleware/error.ts duplicates logic from src/utils/errors.ts. Consolidating these into a single module would reduce confusion for agents trying to understand which error utility to use.", "priority": 60 },
    { "text": "Test infrastructure: There are no integration tests for the API routes. Adding a test harness that spins up the dev server and runs requests against it would catch the class of bugs where routes 404 due to missing registration.", "priority": 80 },
    { "text": "Dead code: src/utils/legacy-auth.ts is imported nowhere and appears to be left over from a previous auth system. Removing it would reduce noise for agents scanning the codebase.", "priority": 30 }
  ]
}
\`\`\`

All scores are 0-10. The e2eScore specifically measures how well the change works when actually tested, not just how the code looks.

## Priority Scoring

Every doc suggestion and project suggestion must include a \`priority\` field (0-100):
- **80-100**: Critical pattern that caused a major failure; fixing this would prevent a whole class of bugs.
- **50-79**: Useful improvement that would meaningfully help agents or reviewers.
- **20-49**: Minor nice-to-have; low impact on agent success.
- **0-19**: Trivial or barely relevant; unlikely to matter.

Be honest with priorities. A suggestion that addresses a root-cause failure pattern that would affect many features deserves 80+. A minor style or cleanup suggestion is 20-40.

## Documentation Suggestions

Based on what you learned from reviewing and testing this code, suggest documentation changes that would help in two ways:

1. **Help coding agents** do better on FUTURE similar tasks — patterns, conventions, gotchas they should know.
2. **Help future reviewers** (like you) better evaluate changes — testing strategies that worked, verification processes, scripts or commands that reliably catch issues, ways to set up end-to-end testing for this area of the codebase.

Add all suggestions to the \`docSuggestions\` array.

Each suggestion is a string that specifies which file to create or update AND includes the full substantive content — file paths, function signatures, conventions, examples, gotchas. A separate agent will read your suggestions and edit the actual doc files, so give it everything it needs without having to re-investigate the codebase.

Good suggestion for coding agents (has the meat):
- "Create docs/patterns/error-handling.md: All async route handlers in src/routes/ must be wrapped with withErrorHandler() from src/middleware/error.ts. This wrapper catches thrown errors and returns a standardized { error: string, code: number } JSON response. Without it, unhandled rejections crash the server. Example: export default withErrorHandler(async (req, res) => { ... })"
- "Update docs/architecture.md, section 'Data Layer': Add that all database queries go through src/db/queries.ts, never raw SQL in route handlers. The query functions handle connection pooling and return typed results. Import pattern: import { getUser, createUser } from '@/db/queries'"

Good suggestion for reviewers (testing strategies, verification):
- "Update docs/testing.md, section 'E2E Verification': To test API route changes end-to-end, write a temporary script that starts the dev server with 'bun run dev', waits for port 3000, then curls each affected endpoint. Example: const proc = Bun.spawn(['bun', 'run', 'dev']); await fetch('http://localhost:3000/api/health'); // verify response shape"
- "Create docs/testing/payment-flow.md: Testing payment-related changes requires seeding the test DB with a user and subscription via src/db/seed.ts, then hitting POST /api/checkout with a Stripe test token. The key assertion is that the webhook handler at src/routes/webhook.ts correctly updates user.plan — check the DB directly after the webhook fires."

Bad suggestion (too vague, forces the refactorer to figure it out):
- "Add something about error handling conventions"
- "Document how to test this area"

Guidelines:
- Focus on GENERAL PATTERNS, not task-specific fixes.
- Include concrete file paths, function names, type signatures, import patterns, and examples.
- Describe edits to existing docs when they're incomplete or wrong, not just new docs.
- For reviewer suggestions, focus on reusable testing strategies — what to spin up, what to seed, what to assert, what scripts to write. These help future judges verify correctness beyond just reading the diff.
- If the agent scored 9+, suggestions are optional.
- If weaknesses are too task-specific to generalize, leave docSuggestions empty.

## Project Improvement Suggestions

Beyond documentation, suggest changes to the **project itself** that would make the codebase easier for coding agents to work with. These are changes to source code, tests, dependencies, or infrastructure — not docs.

Think about what structural improvements would have helped the agent succeed. Add suggestions to the \`projectSuggestions\` array. Categories to consider:

1. **Refactors** — confusing code structure, duplicated logic, or misleading abstractions that tripped up the agent. Suggest a specific refactor that would simplify things.
2. **Dead code / unnecessary dependencies** — unused files, exports, or packages that add noise and confuse agents scanning the codebase.
3. **Test infrastructure** — missing test harnesses, fixtures, or scripts that would let agents (and reviewers) verify changes end-to-end. E.g., "Add a test helper that spins up the dev server and seeds test data."
4. **Environment / build** — confusing build steps, missing setup scripts, or environment issues that caused the agent to waste time.
5. **Feature ideas** — small features or utilities that would simplify common patterns agents need to implement.

Each suggestion should be a self-contained description of one change, with enough detail that a coding agent could implement it independently:
- What to change and where (file paths, modules)
- Why it would help (what problem it solves)
- What the end state should look like

Good project suggestion:
- { "text": "Refactor: src/middleware/error.ts and src/utils/errors.ts both define error formatting logic. Consolidate into src/utils/errors.ts and re-export from middleware.", "priority": 60 }
- { "text": "Test infrastructure: Add a test helper in tests/helpers/server.ts that starts the dev server on a random port, seeds the DB, and returns a cleanup function.", "priority": 80 }
- { "text": "Dead code: src/utils/legacy-auth.ts is imported nowhere. Remove it to reduce noise.", "priority": 25 }

If the agent scored 9.5+ or no project-level issues were observed, leave projectSuggestions empty.

IMPORTANT: You MUST write the result file. This is the only way your review gets recorded. Do it as your very last action.`
}

async function runCodexReviewer(
  prompt: string,
  cwd: string,
  timeoutMs: number = 40 * 60 * 1000,
): Promise<JudgingResult | null> {
  const codex = new Codex({
    apiKey: process.env.OPENAI_API_KEY,
  })

  const thread = codex.startThread({
    model: 'gpt-5.4',
    workingDirectory: cwd,
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    webSearchMode: 'live',
    modelReasoningEffort: 'high',
  })

  const abortController = new AbortController()
  const timer = setTimeout(() => {
    abortController.abort()
  }, timeoutMs)

  try {
    const { events } = await thread.runStreamed(prompt, {
      signal: abortController.signal,
    })

    for await (const event of events) {
      // Events are captured in traces; no console output needed
    }
  } catch {
    // Errors are handled by the caller via null result
  } finally {
    clearTimeout(timer)
  }

  // Try to read the result file
  const resultPath = path.join(cwd, RESULT_FILE_NAME)
  return parseResultFile(resultPath, 'codex')
}

function parseResultFile(
  resultPath: string,
  agentType: string,
): JudgingResult | null {
  try {
    if (!fs.existsSync(resultPath)) return null
    const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
    const parsed = JudgingResultSchema.safeParse(raw)
    if (parsed.success) {
      return parsed.data
    }
    return salvagePartialResult(raw)
  } catch {
    return null
  }
}

function salvagePartialResult(raw: any): JudgingResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  if (typeof raw.overallScore !== 'number') return null

  return {
    analysis: raw.analysis || 'No analysis provided',
    strengths: Array.isArray(raw.strengths) ? raw.strengths : [],
    weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses : [],
    e2eTestsPerformed: Array.isArray(raw.e2eTestsPerformed)
      ? raw.e2eTestsPerformed
      : [],
    completionScore:
      typeof raw.completionScore === 'number' ? raw.completionScore : raw.overallScore,
    codeQualityScore:
      typeof raw.codeQualityScore === 'number'
        ? raw.codeQualityScore
        : raw.overallScore,
    e2eScore:
      typeof raw.e2eScore === 'number' ? raw.e2eScore : raw.overallScore,
    overallScore: raw.overallScore,
  }
}

// --- Public API ---

export interface JudgeTaskResultInput {
  taskPrompt: string
  agentDiff: string
  groundTruthDiff?: string
  repoDir: string
  error?: string
}

export async function judgeTaskResult(
  input: JudgeTaskResultInput,
): Promise<JudgingResult> {
  const { taskPrompt, agentDiff, groundTruthDiff, repoDir, error } = input

  const prompt = buildReviewerPrompt({
    taskPrompt,
    agentDiff,
    groundTruthDiff,
    error,
    docsDir: fs.existsSync(path.join(repoDir, 'docs')) ? repoDir : undefined,
  })

  const maxRetries = 2
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await runCodexReviewer(prompt, repoDir)
    if (result) return result
  }

  return {
    analysis: 'Error: reviewer agent failed to provide results after retries',
    strengths: [],
    weaknesses: ['Reviewer agent failed'],
    e2eTestsPerformed: [],
    completionScore: 0,
    codeQualityScore: 0,
    e2eScore: 0,
    overallScore: 0,
  }
}
