/**
 * Data loader for evalbuff log directories.
 * Reads plan, features, rounds, judging results, diffs, and summaries.
 */
import fs from 'fs'
import path from 'path'

// --- Types matching the file formats ---

export interface CarvePlan {
  reasoning: string
  candidates: CarveCandidate[]
}

export interface CarveCandidate {
  id: string
  name: string
  prompt: string
  description: string
  files: string[]
  relevantFiles: string[]
  complexity: 'small' | 'medium' | 'large'
}

export interface CarvedFeature {
  id: string
  prompt: string
  description: string
  complexity: 'small' | 'medium' | 'large'
  originalFiles: Record<string, string>
  operations: Array<{ path: string; action: string; newContent?: string }>
  diff: string
}

export interface Suggestion {
  text: string
  priority: number
}

export interface JudgingResult {
  analysis: string
  strengths: string[]
  weaknesses: string[]
  e2eTestsPerformed: string[]
  completionScore: number
  codeQualityScore: number
  e2eScore: number
  overallScore: number
  docSuggestions?: Suggestion[]
}

export interface RoundFeatureData {
  featureId: string
  score: number
  costEstimate: number
  diff: string
  judging: JudgingResult | null
  trace: string
}

export interface RoundData {
  round: number
  avgScore: number
  totalCost: number
  features: RoundFeatureData[]
}

export interface LoopData {
  loop: number
  judgeSuggestions: string
  docsDiff: string
  docGates: unknown | null
}

export interface RunSummary {
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
  scoreProgression: number[]
}

export interface LogDirData {
  logDir: string
  plan: CarvePlan | null
  features: CarvedFeature[]
  rounds: RoundData[]
  loops: LoopData[]
  summary: RunSummary | null
  report: string
}

// --- Loader ---

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** Load all available data from a log directory */
export function loadLogDir(logDir: string): LogDirData {
  const plan = readJsonSafe<CarvePlan>(path.join(logDir, 'plan.json'))
  const features = readJsonSafe<CarvedFeature[]>(path.join(logDir, 'features.json')) || []
  const summary = readJsonSafe<RunSummary>(path.join(logDir, 'summary.json'))
  const report = readTextSafe(path.join(logDir, 'report.md'))

  // Load rounds
  const rounds: RoundData[] = []
  for (let r = 0; r < 20; r++) {
    const roundDir = path.join(logDir, `round-${r}`)
    if (!fs.existsSync(roundDir)) break

    const roundSummary = readJsonSafe<{ round: number; avgScore: number; totalCost: number; tasks: Array<{ featureId: string; score: number; costEstimate: number }> }>(
      path.join(roundDir, 'summary.json')
    )

    const featureData: RoundFeatureData[] = []
    try {
      const entries = fs.readdirSync(roundDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const featureDir = path.join(roundDir, entry.name)
        featureData.push({
          featureId: entry.name,
          score: parseFloat(readTextSafe(path.join(featureDir, 'score.txt'))) || -1,
          costEstimate: roundSummary?.tasks?.find(t => t.featureId === entry.name)?.costEstimate || 0,
          diff: readTextSafe(path.join(featureDir, 'diff.txt')),
          judging: readJsonSafe<JudgingResult>(path.join(featureDir, 'judging.json')),
          trace: readTextSafe(path.join(featureDir, 'trace.txt')),
        })
      }
    } catch {}

    rounds.push({
      round: r,
      avgScore: roundSummary?.avgScore || 0,
      totalCost: roundSummary?.totalCost || 0,
      features: featureData,
    })
  }

  // Load loop data (docs writer)
  const loops: LoopData[] = []
  for (let l = 1; l < 20; l++) {
    const suggestionsPath = path.join(logDir, `judge-suggestions-loop-${l}.txt`)
    if (!fs.existsSync(suggestionsPath)) break
    loops.push({
      loop: l,
      judgeSuggestions: readTextSafe(suggestionsPath),
      docsDiff: readTextSafe(path.join(logDir, `docs-diff-loop-${l}.txt`)),
      docGates: readJsonSafe(path.join(logDir, `doc-gates-loop-${l}.json`)),
    })
  }

  return { logDir, plan, features, rounds, loops, summary, report }
}

/** Incrementally reload just the parts that might have changed */
export function reloadLogDir(existing: LogDirData): LogDirData {
  return loadLogDir(existing.logDir)
}
