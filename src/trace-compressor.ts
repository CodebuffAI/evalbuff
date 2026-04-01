/**
 * trace-compressor.ts — Compress verbose agent traces by extracting large
 * tool outputs into sidecar files, keeping an inline trace with stable
 * content-hash pointers and human-readable summaries.
 *
 * Supports:
 *   - JSON-lines (JSONL) streams  — PrintModeEvent lines from the Claude runner
 *   - Plain-text traces           — free-form text with fenced / tagged blocks
 *
 * Sidecar IDs are derived from SHA-256(content), so identical content across
 * different trace runs always produces the same pointer and only one file.
 *
 * Usage (programmatic):
 *   import { compressTrace, restoreTrace } from './trace-compressor'
 *
 *   const { compressed, manifest, stats } = await compressTrace(rawTrace, {
 *     sidecarDir: '/tmp/run/trace.sidecars',
 *     threshold: 2048,
 *     summarize: 'heuristic',
 *   })
 *
 * Usage (CLI):
 *   bun run src/trace-compressor.ts trace.txt [options]
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import Anthropic from '@anthropic-ai/sdk'

// =============================================================================
// Public types
// =============================================================================

/** A stable pointer embedded in the compressed trace in place of large content. */
export interface SidecarRef {
  /** Sentinel so consumers can detect this quickly. */
  __sidecar__: true
  /** 12-char hex SHA-256 prefix of the original content — stable across runs. */
  sidecarId: string
  /** Filename within the sidecar directory, e.g. "sidecar_abc123def456.json" */
  file: string
  /** Original byte count of the extracted content. */
  byteCount: number
  /** One-line human-readable summary of the content. */
  summary: string
  /** How to interpret the sidecar file when restoring: 'text' | 'json' */
  contentType: SidecarContentType
}

export type SidecarContentType = 'text' | 'json'

/** One entry in the manifest index written alongside all sidecars. */
export interface ManifestEntry {
  sidecarId: string
  file: string
  byteCount: number
  summary: string
  contentType: SidecarContentType
  /** Human-readable hint about the original location, e.g. "tool_result:Read:line 12" */
  hint: string
}

/** Written to <sidecarDir>/manifest.json */
export interface SidecarManifest {
  version: 1
  created: string
  threshold: number
  format: 'jsonl' | 'text'
  entries: ManifestEntry[]
}

export interface CompressOptions {
  /** Path to directory where sidecar files are written (created if absent). */
  sidecarDir: string
  /**
   * Byte length above which content is extracted to a sidecar.
   * Default: 2 048 (2 KiB).
   */
  threshold?: number
  /**
   * How to produce inline summaries:
   *   'heuristic' (default) — no API call, uses first-line + stats
   *   'claude'              — calls claude-haiku-4-5 for a one-sentence summary
   *   'none'                — summary is just the byte count
   */
  summarize?: 'heuristic' | 'claude' | 'none'
  /**
   * Force the input format.  Default 'auto' detects from content.
   */
  format?: 'auto' | 'jsonl' | 'text'
  /** Anthropic API key when summarize='claude'. Falls back to ANTHROPIC_API_KEY env var. */
  anthropicApiKey?: string
}

export interface CompressResult {
  /** The compressed trace text ready to write to disk. */
  compressed: string
  /** Index of all extracted sidecars. */
  manifest: SidecarManifest
  stats: {
    format: 'jsonl' | 'text'
    originalBytes: number
    compressedBytes: number
    sidecarCount: number
    reductionPct: number
  }
}

// =============================================================================
// Internal types
// =============================================================================

interface CompressContext {
  sidecarDir: string
  threshold: number
  summarize: (content: string, hint: string) => Promise<string>
  entries: ManifestEntry[]
  lineNum: number
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_THRESHOLD = 2_048

/** Sentinel wrappers used for string-typed sidecar pointers inside JSONL fields. */
const STR_SENTINEL_OPEN = '[[sidecar:'
const STR_SENTINEL_CLOSE = ']]'

/** Regex patterns for block detection in plain-text traces.
 *
 * FENCE_RE captures:
 *   m[1] = opening line including its newline  (e.g. "```python\n")
 *   m[2] = body                                (no leading/trailing newline)
 *   m[3] = "\n" + closing fence               (e.g. "\n```")
 *
 * Keeping the newline before the closing fence in m[3] ensures that restoring
 * m[2] from a sidecar does not produce an extra blank line.
 *
 * XML_BLOCK_RE captures:
 *   m[1] = tag name
 *   m[2] = optional attributes (may be undefined)
 *   m[3] = body (including surrounding whitespace/newlines)
 */
const FENCE_RE = /(`{3}[^\n]*\n)([\s\S]*?)(\n`{3})/g
const XML_BLOCK_RE =
  /<(result|output|tool_result|content)(\s[^>]*)?>(\s*[\s\S]*?)<\/\1>/gi
// LABEL_BLOCK_RE stops at a blank line (two consecutive newlines).  This
// prevents it from accidentally swallowing fenced blocks or the next step that
// follow the labelled content.  The `s` flag makes `.` match newlines so the
// negative-lookahead `(?!\n\n)` can detect blank-line boundaries.
const LABEL_BLOCK_RE =
  /((?:Result|Output|Tool output|Response|Tool result):\s*\n)((?:(?!\n\n).)+)/gis

// =============================================================================
// Utility — stable content hashing
// =============================================================================

function contentHash(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex').slice(0, 12)
}

// =============================================================================
// Utility — sidecar file I/O
// =============================================================================

/**
 * Write content to a sidecar file named by its content hash.
 * Idempotent: if the file already exists (same hash = same content) it is left
 * unchanged.
 */
function writeSidecar(
  sidecarDir: string,
  content: string,
  ext: string,
): { sidecarId: string; file: string } {
  const sidecarId = contentHash(content)
  const file = `sidecar_${sidecarId}.${ext}`
  const filePath = path.join(sidecarDir, file)
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8')
  }
  return { sidecarId, file }
}

// =============================================================================
// Utility — summarisation strategies
// =============================================================================

function summarizeHeuristic(content: string): string {
  const lines = content.trim().split('\n')
  const byteCount = Buffer.byteLength(content, 'utf8')
  const preview = content.slice(0, 140).replace(/\s+/g, ' ').trim()
  const ellipsis = content.length > 140 ? '…' : ''
  return `[${byteCount.toLocaleString('en')} bytes, ${lines.length.toLocaleString('en')} lines] ${preview}${ellipsis}`
}

async function summarizeClaude(
  client: Anthropic,
  content: string,
  hint: string,
): Promise<string> {
  const contextNote = hint ? ` (from ${hint})` : ''
  const excerpt = content.slice(0, 6_000)
  const truncNote = content.length > 6_000 ? '\n[…output truncated for summarisation…]' : ''
  const prompt =
    `Summarise the following tool output${contextNote} in a single sentence (≤ 25 words). ` +
    `Be concrete — mention counts, key values, or the main action.\n\n` +
    `\`\`\`\n${excerpt}${truncNote}\n\`\`\``
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  })
  const block = response.content[0]
  return block.type === 'text' ? block.text.trim() : summarizeHeuristic(content)
}

// =============================================================================
// Format detection
// =============================================================================

/**
 * Auto-detect whether a trace is JSONL or plain text.
 * Votes based on whether ≥60 % of sampled lines parse as JSON objects.
 */
export function detectFormat(content: string): 'jsonl' | 'text' {
  const lines = content.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return 'text'
  const sample = lines.slice(0, Math.min(20, lines.length))
  const hits = sample.filter((l) => {
    try {
      const v = JSON.parse(l)
      return typeof v === 'object' && v !== null
    } catch {
      return false
    }
  }).length
  return hits / sample.length >= 0.6 ? 'jsonl' : 'text'
}

// =============================================================================
// String-sentinel helpers (for string-typed fields in JSONL)
// =============================================================================

/** Type-guard: detects a string sidecar pointer, e.g. "[[sidecar:abc123|…]]". */
export function isStrSidecarPointer(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.startsWith(STR_SENTINEL_OPEN) &&
    v.endsWith(STR_SENTINEL_CLOSE)
  )
}

/** Build the inline string sentinel from a SidecarRef. */
function buildStrPointer(ref: SidecarRef): string {
  return `${STR_SENTINEL_OPEN}${ref.sidecarId}|${ref.file}|${ref.byteCount}|${ref.summary}${STR_SENTINEL_CLOSE}`
}

/** Parse the components out of a string sentinel. */
function parseStrPointer(
  pointer: string,
): Pick<SidecarRef, 'sidecarId' | 'file' | 'byteCount' | 'summary'> | null {
  if (!isStrSidecarPointer(pointer)) return null
  const inner = pointer.slice(
    STR_SENTINEL_OPEN.length,
    pointer.length - STR_SENTINEL_CLOSE.length,
  )
  // Split on | but limit to 4 parts so summary can contain pipes
  const idx1 = inner.indexOf('|')
  const idx2 = inner.indexOf('|', idx1 + 1)
  const idx3 = inner.indexOf('|', idx2 + 1)
  if (idx1 < 0 || idx2 < 0 || idx3 < 0) return null
  return {
    sidecarId: inner.slice(0, idx1),
    file: inner.slice(idx1 + 1, idx2),
    byteCount: parseInt(inner.slice(idx2 + 1, idx3), 10),
    summary: inner.slice(idx3 + 1),
  }
}

// =============================================================================
// Type guard — object SidecarRef
// =============================================================================

/** Type-guard: detects a SidecarRef object embedded in a parsed JSON value. */
export function isSidecarRef(v: unknown): v is SidecarRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__sidecar__ === true
  )
}

// =============================================================================
// JSONL — compression
// =============================================================================

/**
 * Recursively walk a parsed JSON value and extract any sub-tree that, when
 * serialised, exceeds the byte threshold.
 *
 * Strings are replaced with an inline string sentinel (so the field type
 * stays `string` in the output JSON).
 * Arrays / objects are replaced with an object SidecarRef.
 */
async function compressValue(
  value: unknown,
  hint: string,
  ctx: CompressContext,
): Promise<unknown> {
  // ── String ───────────────────────────────────────────────────────────────
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > ctx.threshold) {
      const summary = await ctx.summarize(value, hint)
      const { sidecarId, file } = writeSidecar(ctx.sidecarDir, value, 'txt')
      const ref: SidecarRef = {
        __sidecar__: true,
        sidecarId,
        file,
        byteCount: bytes,
        summary,
        contentType: 'text',
      }
      ctx.entries.push({ sidecarId, file, byteCount: bytes, summary, contentType: 'text', hint })
      return buildStrPointer(ref)
    }
    return value
  }

  // ── Array ────────────────────────────────────────────────────────────────
  if (Array.isArray(value)) {
    const serialised = JSON.stringify(value)
    const bytes = Buffer.byteLength(serialised, 'utf8')
    if (bytes > ctx.threshold) {
      const summary = await ctx.summarize(serialised, hint)
      const { sidecarId, file } = writeSidecar(ctx.sidecarDir, serialised, 'json')
      const ref: SidecarRef = {
        __sidecar__: true,
        sidecarId,
        file,
        byteCount: bytes,
        summary,
        contentType: 'json',
      }
      ctx.entries.push({ sidecarId, file, byteCount: bytes, summary, contentType: 'json', hint })
      return ref
    }
    // Small enough — recurse into items
    return Promise.all(
      value.map((item, i) => compressValue(item, `${hint}[${i}]`, ctx)),
    )
  }

  // ── Object ───────────────────────────────────────────────────────────────
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = await compressValue(v, `${hint}.${k}`, ctx)
    }
    return result
  }

  // ── Primitive ────────────────────────────────────────────────────────────
  return value
}

/**
 * Compress one parsed JSONL event object.
 *
 * Applies targeted extraction for well-known large-content fields in
 * PrintModeEvent variants (tool_result.output, text.text, reasoning_delta.text),
 * then falls back to a general recursive sweep for unknown event types.
 */
async function compressEvent(
  event: Record<string, unknown>,
  lineNum: number,
  ctx: CompressContext,
): Promise<Record<string, unknown>> {
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const toolName = typeof event.toolName === 'string' ? event.toolName : ''
  const baseHint = toolName
    ? `${type}:${toolName}:line ${lineNum}`
    : `${type}:line ${lineNum}`

  // ── tool_result — output array ──────────────────────────────────────────
  if (type === 'tool_result' && Array.isArray(event.output)) {
    const serialised = JSON.stringify(event.output)
    const bytes = Buffer.byteLength(serialised, 'utf8')
    if (bytes > ctx.threshold) {
      const summary = await ctx.summarize(serialised, baseHint)
      const { sidecarId, file } = writeSidecar(ctx.sidecarDir, serialised, 'json')
      const ref: SidecarRef = {
        __sidecar__: true,
        sidecarId,
        file,
        byteCount: bytes,
        summary,
        contentType: 'json',
      }
      ctx.entries.push({ sidecarId, file, byteCount: bytes, summary, contentType: 'json', hint: baseHint })
      return { ...event, output: ref }
    }
    // Output array small overall — recurse into individual items
    const compressedOutput = await Promise.all(
      (event.output as unknown[]).map((item, i) =>
        compressValue(item, `${baseHint}.output[${i}]`, ctx),
      ),
    )
    return { ...event, output: compressedOutput }
  }

  // ── text / reasoning_delta — text field ─────────────────────────────────
  if (
    (type === 'text' || type === 'reasoning_delta') &&
    typeof event.text === 'string'
  ) {
    const bytes = Buffer.byteLength(event.text, 'utf8')
    if (bytes > ctx.threshold) {
      const summary = await ctx.summarize(event.text, baseHint)
      const { sidecarId, file } = writeSidecar(ctx.sidecarDir, event.text, 'txt')
      const ref: SidecarRef = {
        __sidecar__: true,
        sidecarId,
        file,
        byteCount: bytes,
        summary,
        contentType: 'text',
      }
      ctx.entries.push({ sidecarId, file, byteCount: bytes, summary, contentType: 'text', hint: baseHint })
      return { ...event, text: buildStrPointer(ref) }
    }
    return event
  }

  // ── Generic fallback ─────────────────────────────────────────────────────
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(event)) {
    result[k] = await compressValue(v, `${baseHint}.${k}`, ctx)
  }
  return result
}

async function compressJsonl(lines: string[], ctx: CompressContext): Promise<string[]> {
  const output: string[] = []
  let lineNum = 0

  for (const raw of lines) {
    const trimmed = raw.trimEnd()
    if (!trimmed) {
      output.push(raw)
      continue
    }
    lineNum++
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      output.push(raw) // non-JSON line — pass through
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      output.push(raw)
      continue
    }
    ctx.lineNum = lineNum
    const compressed = await compressEvent(parsed as Record<string, unknown>, lineNum, ctx)
    output.push(JSON.stringify(compressed))
  }
  return output
}

// =============================================================================
// Plain-text — compression
// =============================================================================

/** Build the multi-line inline pointer used in plain-text traces. */
function buildTextPointer(ref: SidecarRef): string {
  return (
    `[[SIDECAR:${ref.file}]]\n` +
    `  bytes    : ${ref.byteCount.toLocaleString('en')}\n` +
    `  summary  : ${ref.summary}\n` +
    `  sidecarId: ${ref.sidecarId}`
  )
}

/**
 * Async variant of String.replace that uses a stateful regex and awaits each
 * replacement function.  Processes matches in reverse-index order so string
 * positions remain valid.
 */
async function replaceAsync(
  str: string,
  re: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const segments: Array<{ index: number; len: number; replacement: string }> = []
  const rx = new RegExp(re.source, re.flags.replace('g', '') + 'g')
  let m: RegExpExecArray | null
  while ((m = rx.exec(str)) !== null) {
    const replacement = await replacer(m)
    segments.push({ index: m.index, len: m[0].length, replacement })
  }
  // Rebuild string applying replacements in reverse order
  let result = str
  for (let i = segments.length - 1; i >= 0; i--) {
    const { index, len, replacement } = segments[i]
    result = result.slice(0, index) + replacement + result.slice(index + len)
  }
  return result
}

async function compressPlainText(text: string, ctx: CompressContext): Promise<string> {
  let blockIndex = 0

  /**
   * If `body` exceeds the threshold, extract it and return the pointer;
   * otherwise return `full` unchanged.
   */
  async function maybeExtract(
    full: string,
    body: string,
    hint: string,
    ext: string,
    wrap: (pointer: string) => string,
  ): Promise<string> {
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes <= ctx.threshold) return full
    const summary = await ctx.summarize(body, hint)
    const { sidecarId, file } = writeSidecar(ctx.sidecarDir, body, ext)
    const ref: SidecarRef = {
      __sidecar__: true,
      sidecarId,
      file,
      byteCount: bytes,
      summary,
      contentType: 'text',
    }
    ctx.entries.push({ sidecarId, file, byteCount: bytes, summary, contentType: 'text', hint })
    return wrap(buildTextPointer(ref))
  }

  // 1. Markdown fenced code blocks  ``` … ```
  text = await replaceAsync(text, FENCE_RE, async (m) => {
    blockIndex++
    return maybeExtract(
      m[0],
      m[2], // captured body between fences
      `fenced-block:${blockIndex}`,
      'txt',
      // m[3] already starts with "\n" (captured before closing fence),
      // so no extra newline is needed here.
      (ptr) => `${m[1]}${ptr}${m[3]}`,
    )
  })

  // 2. XML-style <result>…</result>, <output>…</output>, etc.
  text = await replaceAsync(text, XML_BLOCK_RE, async (m) => {
    blockIndex++
    const tag = m[1]
    const attrs = m[2] ?? ''
    const body = m[3]
    return maybeExtract(
      m[0],
      body,
      `xml-${tag}:${blockIndex}`,
      'txt',
      (ptr) => `<${tag}${attrs}>${ptr}</${tag}>`,
    )
  })

  // 3. Label-prefix blocks ("Result:\n…")
  text = await replaceAsync(text, LABEL_BLOCK_RE, async (m) => {
    blockIndex++
    return maybeExtract(
      m[0],
      m[2],
      `label-${m[1].trim()}:${blockIndex}`,
      'txt',
      (ptr) => `${m[1]}${ptr}`,
    )
  })

  return text
}

// =============================================================================
// Main public API
// =============================================================================

/**
 * Compress a trace string, extracting all large blocks to sidecar files.
 *
 * @param traceContent  Raw trace (JSONL or plain text)
 * @param opts          Options — only `sidecarDir` is required
 * @returns             Compressed text, manifest metadata, and statistics
 */
export async function compressTrace(
  traceContent: string,
  opts: CompressOptions,
): Promise<CompressResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const summarizeMode = opts.summarize ?? 'heuristic'
  const fmt =
    !opts.format || opts.format === 'auto'
      ? detectFormat(traceContent)
      : opts.format

  fs.mkdirSync(opts.sidecarDir, { recursive: true })

  let claudeClient: Anthropic | null = null
  const summarize = async (content: string, hint: string): Promise<string> => {
    if (summarizeMode === 'claude') {
      claudeClient ??= new Anthropic({ apiKey: opts.anthropicApiKey })
      return summarizeClaude(claudeClient, content, hint)
    }
    if (summarizeMode === 'none') {
      return `[${Buffer.byteLength(content, 'utf8').toLocaleString('en')} bytes]`
    }
    return summarizeHeuristic(content)
  }

  const ctx: CompressContext = {
    sidecarDir: opts.sidecarDir,
    threshold,
    summarize,
    entries: [],
    lineNum: 0,
  }

  let compressed: string
  if (fmt === 'jsonl') {
    const compressedLines = await compressJsonl(traceContent.split('\n'), ctx)
    compressed = compressedLines.join('\n')
  } else {
    compressed = await compressPlainText(traceContent, ctx)
  }

  const manifest: SidecarManifest = {
    version: 1,
    created: new Date().toISOString(),
    threshold,
    format: fmt,
    entries: ctx.entries,
  }
  fs.writeFileSync(
    path.join(opts.sidecarDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )

  const originalBytes = Buffer.byteLength(traceContent, 'utf8')
  const compressedBytes = Buffer.byteLength(compressed, 'utf8')
  const reductionPct =
    originalBytes > 0
      ? Math.round((1 - compressedBytes / originalBytes) * 1000) / 10
      : 0

  return {
    compressed,
    manifest,
    stats: { format: fmt, originalBytes, compressedBytes, sidecarCount: ctx.entries.length, reductionPct },
  }
}

// =============================================================================
// Restoration
// =============================================================================

/** Read a sidecar file and return the original value. */
function readSidecar(sidecarDir: string, file: string, contentType: SidecarContentType): unknown {
  const raw = fs.readFileSync(path.join(sidecarDir, file), 'utf8')
  return contentType === 'json' ? JSON.parse(raw) : raw
}

function restoreValue(value: unknown, sidecarDir: string): unknown {
  // String sentinel
  if (isStrSidecarPointer(value)) {
    const info = parseStrPointer(value as string)
    if (info) return readSidecar(sidecarDir, info.file, 'text')
    return value
  }
  // Object SidecarRef
  if (isSidecarRef(value)) {
    return readSidecar(sidecarDir, value.file, value.contentType)
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreValue(item, sidecarDir))
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = restoreValue(v, sidecarDir)
    }
    return result
  }
  return value
}

function restoreJsonl(content: string, sidecarDir: string): string {
  return content
    .split('\n')
    .map((raw) => {
      const trimmed = raw.trimEnd()
      if (!trimmed) return raw
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return raw
      }
      return JSON.stringify(restoreValue(parsed, sidecarDir))
    })
    .join('\n')
}

/** Matches the multi-line plain-text pointer block produced by buildTextPointer. */
const TEXT_POINTER_RE =
  /\[\[SIDECAR:([^\]]+)\]\]\n[ \t]+bytes\s*:[ \t]+[\d,]+\n[ \t]+summary\s*:[ \t]+.+\n[ \t]+sidecarId\s*:[ \t]+[a-f0-9]+/g

function restorePlainText(content: string, sidecarDir: string): string {
  // Iterate until stable: handles cases where a sidecar's content itself
  // contains embedded sidecar pointers (e.g. when a label block was extracted
  // after fence compression had already placed a pointer inside its range).
  let prev = ''
  let current = content
  while (prev !== current) {
    prev = current
    current = current.replace(TEXT_POINTER_RE, (match, file: string) => {
      const filePath = path.join(sidecarDir, file)
      if (!fs.existsSync(filePath)) return match
      return fs.readFileSync(filePath, 'utf8')
    })
  }
  return current
}

/**
 * Restore a compressed trace to its original form by expanding all sidecar
 * references.
 *
 * @param compressedContent  Text produced by `compressTrace`
 * @param sidecarDir         Directory containing the sidecar files
 * @param format             'auto' (default) to detect, or 'jsonl' / 'text'
 * @returns                  Original trace text
 */
export function restoreTrace(
  compressedContent: string,
  sidecarDir: string,
  format: 'auto' | 'jsonl' | 'text' = 'auto',
): string {
  const fmt = format === 'auto' ? detectFormat(compressedContent) : format
  return fmt === 'jsonl'
    ? restoreJsonl(compressedContent, sidecarDir)
    : restorePlainText(compressedContent, sidecarDir)
}

// =============================================================================
// Convenience wrapper — used by report.ts integration
// =============================================================================

/**
 * Compress a trace and write both the compressed file and sidecars to disk in
 * one call.  Returns the paths for downstream use.
 */
export async function compressAndSave(
  tracePath: string,
  content: string,
  threshold = DEFAULT_THRESHOLD,
  summarize: CompressOptions['summarize'] = 'heuristic',
): Promise<{ compressedPath: string; sidecarDir: string; stats: CompressResult['stats'] }> {
  const compressedPath = tracePath + '.compressed'
  const sidecarDir = tracePath + '.sidecars'
  const result = await compressTrace(content, { sidecarDir, threshold, summarize })
  fs.writeFileSync(compressedPath, result.compressed, 'utf8')
  return { compressedPath, sidecarDir, stats: result.stats }
}

// =============================================================================
// CLI — bun run src/trace-compressor.ts
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const getFlag = (name: string, def = ''): string => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def
  }
  const hasFlag = (name: string): boolean => args.includes(`--${name}`)
  const positional = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--output'
    && args[args.indexOf(a) - 1] !== '--sidecar-dir'
    && args[args.indexOf(a) - 1] !== '--threshold'
    && args[args.indexOf(a) - 1] !== '--format'
    && args[args.indexOf(a) - 1] !== '--summarize')

  if (args.length === 0 || hasFlag('help') || hasFlag('h')) {
    console.log(`
trace-compressor — extract large tool outputs from agent traces into sidecar files.

Usage:
  bun run src/trace-compressor.ts <input> [options]
  bun run src/trace-compressor.ts --restore <compressed> [options]

Arguments:
  <input>                     Trace file to compress (use "-" for stdin)

Compression options:
  --output <path>             Output file (default: <input>.compressed, or stdout for stdin)
  --sidecar-dir <path>        Sidecar directory (default: <output>.sidecars)
  --threshold <bytes>         Extract if larger than N bytes (default: ${DEFAULT_THRESHOLD})
  --format auto|jsonl|text    Force input format (default: auto-detect)
  --summarize heuristic|claude|none
                              Inline summary strategy (default: heuristic)

Restore options:
  --restore                   Expand sidecar refs back to original content
  --sidecar-dir <path>        Sidecar directory (required with --restore)

General:
  --help                      Show this message
`.trim())
    process.exit(0)
  }

  const isRestore = hasFlag('restore')

  if (isRestore) {
    const inputPath = positional[0]
    if (!inputPath) {
      console.error('Error: provide the compressed trace file as the first positional argument')
      process.exit(1)
    }
    const inputText = inputPath === '-'
      ? fs.readFileSync('/dev/stdin', 'utf8')
      : fs.readFileSync(inputPath, 'utf8')
    const sidecarDir = getFlag('sidecar-dir') || (inputPath !== '-' ? inputPath + '.sidecars' : '')
    if (!sidecarDir) {
      console.error('Error: --sidecar-dir is required when reading from stdin with --restore')
      process.exit(1)
    }
    const outputPath = getFlag('output') || (inputPath !== '-'
      ? inputPath.replace(/\.compressed$/, '') + '.restored'
      : '-')
    const format = (getFlag('format') || 'auto') as 'auto' | 'jsonl' | 'text'

    const restored = restoreTrace(inputText, sidecarDir, format)

    if (outputPath === '-') {
      process.stdout.write(restored)
    } else {
      fs.writeFileSync(outputPath, restored, 'utf8')
      console.error(`✓ Restored → ${outputPath}`)
    }
  } else {
    // Compress mode
    const inputPath = positional[0]
    if (!inputPath) {
      console.error('Error: provide the trace file as the first positional argument')
      process.exit(1)
    }
    const rawContent = inputPath === '-'
      ? fs.readFileSync('/dev/stdin', 'utf8')
      : fs.readFileSync(inputPath, 'utf8')

    const outputPath = getFlag('output') ||
      (inputPath !== '-' ? inputPath + '.compressed' : '-')
    const sidecarDir = getFlag('sidecar-dir') ||
      ((outputPath !== '-' ? outputPath : 'trace') + '.sidecars')
    const threshold = parseInt(getFlag('threshold') || String(DEFAULT_THRESHOLD), 10)
    const format = (getFlag('format') || 'auto') as CompressOptions['format']
    const summarize = (getFlag('summarize') || 'heuristic') as CompressOptions['summarize']

    const { compressed, manifest, stats } = await compressTrace(rawContent, {
      sidecarDir,
      threshold,
      format,
      summarize,
    })

    if (outputPath === '-') {
      process.stdout.write(compressed)
    } else {
      fs.writeFileSync(outputPath, compressed, 'utf8')
    }

    // Stats → stderr (always)
    const saved = stats.originalBytes - stats.compressedBytes
    console.error(
      `\n✓ Compressed (${stats.format})` +
      `  ${stats.originalBytes.toLocaleString('en')} → ${stats.compressedBytes.toLocaleString('en')} bytes` +
      `  (${stats.reductionPct}% reduction, ${saved.toLocaleString('en')} bytes saved)` +
      `  ${stats.sidecarCount} sidecar(s) in ${sidecarDir}/`,
    )
    if (outputPath !== '-') {
      console.error(`  Inline trace : ${outputPath}`)
    }
    console.error(`  Manifest     : ${path.join(sidecarDir, 'manifest.json')}`)

    if (manifest.entries.length > 0) {
      console.error(`\n  Extracted:`)
      const colWidth = Math.max(...manifest.entries.map((e) => e.file.length)) + 2
      for (const e of manifest.entries) {
        const bytes = e.byteCount.toLocaleString('en').padStart(12)
        console.error(`    ${e.file.padEnd(colWidth)} ${bytes} bytes  ${e.hint}`)
      }
    }
  }
}
