/**
 * GPT-5.4 based judge using the OpenAI Responses API.
 *
 * Uses built-in tools (web_search, code_interpreter) and structured
 * output parsing via zodTextFormat for type-safe results.
 */
import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'

import { JudgingResultSchema } from './judge'

import type { JudgingResult } from './judge'

const MODEL = 'gpt-5.4'

const JUDGE_SYSTEM_PROMPT = `You are a senior engineer judging an AI coding agent's attempt at rebuilding a feature that was removed from a codebase.

## Your Job

You are given:
1. The **task prompt** — what the agent was asked to do
2. The **ground truth diff** — the original code that was removed (this is what should be rebuilt)
3. The **agent's diff** — what the agent actually produced

Compare the agent's output against the ground truth and score it.

## Tools Available

You have access to:
- **web_search** — use this if you need to look up API documentation, library usage patterns, or language idioms to verify whether the agent's code follows current best practices.
- **code_interpreter** — use this to run code snippets if you need to verify logic, test regex patterns, or validate data transformations from the diffs.

Use these tools when they would improve the accuracy of your judgment. Do not use them unnecessarily.

## Scoring Criteria

- **completionScore** (0-10): How completely did the agent rebuild the feature? Did it miss files, functions, or key logic?
- **codeQualityScore** (0-10): Is the code well-structured, idiomatic, and maintainable? Does it match the patterns of the codebase?
- **e2eScore** (0-10): Would this code actually work end-to-end? End application manually tested and/or integration tests run to confirm.
- **overallScore** (0-10): Combined assessment weighing all factors.

## Scoring Guidelines

- 9-10: Near-perfect rebuild. All files, all logic, correct patterns.
- 7-8: Good rebuild. Minor gaps (missing edge cases, slightly different patterns) but functionally complete.
- 5-6: Partial rebuild. Core logic present but significant gaps or wrong approach in places.
- 3-4: Weak attempt. Some relevant code but major pieces missing or fundamentally wrong approach.
- 0-2: Failed. Little to no relevant code produced, or completely wrong approach.

## Output

After any tool use, provide your final structured judgment.`

export async function judgeWithOpenAI(opts: {
  taskPrompt: string
  agentDiff: string
  groundTruthDiff: string
}): Promise<JudgingResult> {
  const { taskPrompt, agentDiff, groundTruthDiff } = opts
  const client = new OpenAI()

  const userPrompt = `## Task Prompt
${taskPrompt}

## Ground Truth (original code that was removed)
\`\`\`diff
${groundTruthDiff}
\`\`\`

## Agent's Output (what the agent produced)
\`\`\`diff
${agentDiff || '(No changes made)'}
\`\`\`

Judge the agent's attempt.`

  const response = await client.responses.parse({
    model: MODEL,
    instructions: JUDGE_SYSTEM_PROMPT,
    input: userPrompt,
    tools: [
      { type: 'web_search' },
      {
        type: 'code_interpreter',
        container: { type: 'auto' },
      },
    ],
    text: {
      format: zodTextFormat(JudgingResultSchema, 'judging_result'),
    },
    store: true,
  })

  const result = response.output_parsed
  if (result) {
    return result
  }

  // Fallback: parse from raw text if structured parsing didn't populate
  const text = response.output_text
  if (!text) {
    throw new Error('No response from judge model')
  }

  const raw = JSON.parse(text)
  const parsed = JudgingResultSchema.safeParse(raw)

  if (parsed.success) {
    return parsed.data
  }

  // Attempt to salvage partial result
  if (typeof raw?.overallScore === 'number') {
    return {
      analysis: raw.analysis || 'No analysis provided',
      strengths: Array.isArray(raw.strengths) ? raw.strengths : [],
      weaknesses: Array.isArray(raw.weaknesses) ? raw.weaknesses : [],
      e2eTestsPerformed: [],
      completionScore: typeof raw.completionScore === 'number' ? raw.completionScore : raw.overallScore,
      codeQualityScore: typeof raw.codeQualityScore === 'number' ? raw.codeQualityScore : raw.overallScore,
      e2eScore: typeof raw.e2eScore === 'number' ? raw.e2eScore : raw.overallScore,
      overallScore: raw.overallScore,
    }
  }

  throw new Error(`Judge returned invalid result: ${JSON.stringify(parsed.error)}`)
}
