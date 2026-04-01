/**
 * Patch application logic, ported from codebuff's apply_patch tool.
 *
 * Applies unified-diff-style patches to file content with fuzzy context matching
 * and multiple fallback strategies for trailing newline handling.
 */

type Chunk = {
  origIndex: number
  delLines: string[]
  insLines: string[]
}

type ParserState = {
  lines: string[]
  index: number
  fuzz: number
}

const END_PATCH = '*** End Patch'
const END_FILE = '*** End of File'
const END_SECTION_MARKERS = [
  END_PATCH,
  '*** Update File:',
  '*** Delete File:',
  '*** Add File:',
  END_FILE,
]

const SECTION_TERMINATORS = [
  END_PATCH,
  '*** Update File:',
  '*** Delete File:',
  '*** Add File:',
]

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n')
}

function ensureTrailingNewline(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`
}

function stripTrailingNewline(input: string): string {
  return input.endsWith('\n') ? input.slice(0, -1) : input
}

function sanitizeUnifiedDiff(rawDiff: string): string {
  const diffFenceMatch = rawDiff.match(/```diff\r?\n([\s\S]*?)\r?\n```/i)
  if (diffFenceMatch) {
    return diffFenceMatch[1]!
  }

  const trimmed = rawDiff.trim()
  const fencedMatch = trimmed.match(
    /^```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```$/,
  )
  if (fencedMatch) {
    return fencedMatch[1]!
  }

  return rawDiff
}

function patchHasIntendedChanges(diff: string): boolean {
  return normalizeLineEndings(diff)
    .split('\n')
    .some((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return false
      }

      return line.startsWith('+') || line.startsWith('-')
    })
}

function normalizeDiffLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''))
}

function isDone(state: ParserState, prefixes: string[]): boolean {
  if (state.index >= state.lines.length) {
    return true
  }

  return prefixes.some((prefix) => state.lines[state.index]?.startsWith(prefix))
}

function isWrappedAtHeader(line: string): boolean {
  return /^@@.*@@(?: .*)?$/.test(line)
}

function advanceCursorToAnchor(
  anchor: string,
  inputLines: string[],
  cursor: number,
  parser: ParserState,
): number {
  let found = false

  if (!inputLines.slice(0, cursor).some((line) => line === anchor)) {
    for (let i = cursor; i < inputLines.length; i += 1) {
      if (inputLines[i] === anchor) {
        cursor = i + 1
        found = true
        break
      }
    }
  }

  if (
    !found &&
    !inputLines.slice(0, cursor).some((line) => line.trim() === anchor.trim())
  ) {
    for (let i = cursor; i < inputLines.length; i += 1) {
      if (inputLines[i]?.trim() === anchor.trim()) {
        cursor = i + 1
        parser.fuzz += 1
        found = true
        break
      }
    }
  }

  return cursor
}

function readSection(
  lines: string[],
  startIndex: number,
): {
  nextContext: string[]
  sectionChunks: Chunk[]
  endIndex: number
  eof: boolean
} {
  const context: string[] = []
  let delLines: string[] = []
  let insLines: string[] = []
  const sectionChunks: Chunk[] = []

  let mode: 'keep' | 'add' | 'delete' = 'keep'
  let index = startIndex
  const origIndex = index

  while (index < lines.length) {
    const raw = lines[index]!

    if (
      raw.startsWith('@@') ||
      raw.startsWith(END_PATCH) ||
      raw.startsWith('*** Update File:') ||
      raw.startsWith('*** Delete File:') ||
      raw.startsWith('*** Add File:') ||
      raw.startsWith(END_FILE)
    ) {
      break
    }

    if (raw === '***') {
      break
    }

    if (raw.startsWith('***')) {
      throw new Error(`Invalid Line: ${raw}`)
    }

    index += 1
    const lastMode = mode

    let line = raw
    if (line === '') {
      line = ' '
    }

    if (line[0] === '+') {
      mode = 'add'
    } else if (line[0] === '-') {
      mode = 'delete'
    } else if (line[0] === ' ') {
      mode = 'keep'
    } else {
      throw new Error(`Invalid Line: ${line}`)
    }

    line = line.slice(1)

    const switchingToContext = mode === 'keep' && lastMode !== mode
    if (switchingToContext && (insLines.length > 0 || delLines.length > 0)) {
      sectionChunks.push({
        origIndex: context.length - delLines.length,
        delLines,
        insLines,
      })
      delLines = []
      insLines = []
    }

    if (mode === 'delete') {
      delLines.push(line)
      context.push(line)
    } else if (mode === 'add') {
      insLines.push(line)
    } else {
      context.push(line)
    }
  }

  if (insLines.length > 0 || delLines.length > 0) {
    sectionChunks.push({
      origIndex: context.length - delLines.length,
      delLines,
      insLines,
    })
  }

  if (index < lines.length && lines[index] === END_FILE) {
    index += 1
    return { nextContext: context, sectionChunks, endIndex: index, eof: true }
  }

  if (index === origIndex) {
    throw new Error(`Nothing in this section - index=${index} ${lines[index]}`)
  }

  return { nextContext: context, sectionChunks, endIndex: index, eof: false }
}

function equalsSlice(
  source: string[],
  target: string[],
  start: number,
  mapFn: (value: string) => string,
): boolean {
  if (start + target.length > source.length) {
    return false
  }

  for (let i = 0; i < target.length; i += 1) {
    if (mapFn(source[start + i]!) !== mapFn(target[i]!)) {
      return false
    }
  }

  return true
}

function findContextCore(
  lines: string[],
  context: string[],
  start: number,
): { newIndex: number; fuzz: number } {
  if (context.length === 0) {
    return { newIndex: start, fuzz: 0 }
  }

  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (value) => value)) {
      return { newIndex: i, fuzz: 0 }
    }
  }

  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (value) => value.trimEnd())) {
      return { newIndex: i, fuzz: 1 }
    }
  }

  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (value) => value.trim())) {
      return { newIndex: i, fuzz: 100 }
    }
  }

  return { newIndex: -1, fuzz: 0 }
}

function findContext(
  lines: string[],
  context: string[],
  start: number,
  eof: boolean,
): { newIndex: number; fuzz: number } {
  if (eof) {
    const endStart = Math.max(0, lines.length - context.length)
    const endMatch = findContextCore(lines, context, endStart)
    if (endMatch.newIndex !== -1) {
      return endMatch
    }

    const fallback = findContextCore(lines, context, start)
    return { newIndex: fallback.newIndex, fuzz: fallback.fuzz + 10000 }
  }

  return findContextCore(lines, context, start)
}

function parseUpdateDiff(
  lines: string[],
  input: string,
): { chunks: Chunk[]; fuzz: number } {
  const parser: ParserState = {
    lines: [...lines, END_PATCH],
    index: 0,
    fuzz: 0,
  }

  const inputLines = input.split('\n')
  const chunks: Chunk[] = []
  let cursor = 0

  while (!isDone(parser, END_SECTION_MARKERS)) {
    const current = parser.lines[parser.index]
    const line = typeof current === 'string' ? current : ''

    let anchor = ''
    const hasBareHeader = line === '@@'
    const hasWrappedHeader = isWrappedAtHeader(line)
    const hasAnchorHeader = line.startsWith('@@ ') && !hasWrappedHeader
    const hasAnyHeader = hasBareHeader || hasWrappedHeader || hasAnchorHeader

    if (hasAnchorHeader) {
      anchor = line.slice(3)
      parser.index += 1
    } else if (hasBareHeader || hasWrappedHeader) {
      parser.index += 1
    }

    if (!(hasAnyHeader || cursor === 0)) {
      throw new Error(`Invalid Line:\n${parser.lines[parser.index]}`)
    }

    if (anchor.trim()) {
      cursor = advanceCursorToAnchor(anchor, inputLines, cursor, parser)
    }

    const { nextContext, sectionChunks, endIndex, eof } = readSection(
      parser.lines,
      parser.index,
    )

    const { newIndex, fuzz } = findContext(inputLines, nextContext, cursor, eof)

    if (newIndex === -1) {
      const nextContextText = nextContext.join('\n')
      if (eof) {
        throw new Error(`Invalid EOF Context ${cursor}:\n${nextContextText}`)
      }

      throw new Error(`Invalid Context ${cursor}:\n${nextContextText}`)
    }

    parser.fuzz += fuzz
    for (const chunk of sectionChunks) {
      chunks.push({ ...chunk, origIndex: chunk.origIndex + newIndex })
    }

    cursor = newIndex + nextContext.length
    parser.index = endIndex
  }

  return { chunks, fuzz: parser.fuzz }
}

function applyChunks(input: string, chunks: Chunk[]): string {
  const originalLines = input.split('\n')
  const destinationLines: string[] = []
  let originalIndex = 0

  for (const chunk of chunks) {
    if (chunk.origIndex > originalLines.length) {
      throw new Error(
        `applyDiff: chunk.origIndex ${chunk.origIndex} > input length ${originalLines.length}`,
      )
    }

    if (originalIndex > chunk.origIndex) {
      throw new Error(
        `applyDiff: overlapping chunk at ${chunk.origIndex} (cursor ${originalIndex})`,
      )
    }

    destinationLines.push(...originalLines.slice(originalIndex, chunk.origIndex))
    originalIndex = chunk.origIndex

    if (chunk.insLines.length > 0) {
      destinationLines.push(...chunk.insLines)
    }

    originalIndex += chunk.delLines.length
  }

  destinationLines.push(...originalLines.slice(originalIndex))
  return destinationLines.join('\n')
}

function applyDiffCore(input: string, diff: string): { result: string; fuzz: number } {
  const diffLines = normalizeDiffLines(diff)
  const { chunks, fuzz } = parseUpdateDiff(diffLines, input)
  return { result: applyChunks(input, chunks), fuzz }
}

function isConsistentlyCrlf(input: string): boolean {
  const hasCrlf = /\r\n/.test(input)
  const hasBareLf = /(^|[^\r])\n/.test(input)
  return hasCrlf && !hasBareLf
}

function preserveOriginalLineEndings(original: string, patched: string): string {
  if (!isConsistentlyCrlf(original)) {
    return patched
  }

  return normalizeLineEndings(patched).replace(/\n/g, '\r\n')
}

/**
 * Apply a unified-diff-style patch to file content.
 * Tries multiple strategies for trailing newline handling.
 * Throws on failure.
 */
export function applyPatch(oldContent: string, diff: string): string {
  const sanitizedDiff = sanitizeUnifiedDiff(diff)
  const normalizedDiff = normalizeLineEndings(sanitizedDiff)

  const attempts = [
    { name: 'codex_like', source: normalizeLineEndings(oldContent) },
    { name: 'with_trailing_newline', source: ensureTrailingNewline(normalizeLineEndings(oldContent)) },
    { name: 'without_trailing_newline', source: stripTrailingNewline(normalizeLineEndings(oldContent)) },
  ]

  // Deduplicate identical attempts
  const seen = new Set<string>()
  const strategies: string[] = []
  let lastError: string | undefined

  for (const attempt of attempts) {
    if (seen.has(attempt.source)) continue
    seen.add(attempt.source)
    strategies.push(attempt.name)

    try {
      const { result } = applyDiffCore(attempt.source, normalizedDiff)

      if (patchHasIntendedChanges(normalizedDiff) && result === attempt.source) {
        lastError = 'Patch produced no content changes'
        continue
      }

      return preserveOriginalLineEndings(oldContent, result)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  const msg = [
    `Failed to apply patch.`,
    strategies.length > 0 ? `Tried strategies: ${strategies.join(', ')}.` : undefined,
    lastError ? `Last error: ${lastError}.` : undefined,
  ]
    .filter(Boolean)
    .join(' ')

  throw new Error(msg)
}
