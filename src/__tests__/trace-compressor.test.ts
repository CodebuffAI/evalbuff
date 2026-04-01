/**
 * Unit tests for trace-compressor.ts
 *
 * Tests the core compression / restoration logic for both JSONL and plain-text
 * formats WITHOUT making any API calls (uses summarize='none' throughout).
 *
 * Run: bun test src/__tests__/trace-compressor.test.ts
 */

import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  compressTrace,
  detectFormat,
  isSidecarRef,
  isStrSidecarPointer,
  restoreTrace,
} from '../trace-compressor'

import type { SidecarManifest } from '../trace-compressor'

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-compressor-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Generate a deterministic string of `n` bytes (ASCII). */
function bigString(n: number, char = 'x'): string {
  return char.repeat(n)
}

/** Generate a content hash the same way the module does. */
function sha256Prefix(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)
}

const sidecarDir = () => path.join(tmpDir, 'sidecars')

// ─────────────────────────────────────────────────────────────
// detectFormat
// ─────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('detects jsonl when majority of lines are JSON objects', () => {
    const jsonl = [
      JSON.stringify({ type: 'text', text: 'hello' }),
      JSON.stringify({ type: 'tool_call', toolName: 'Read' }),
      JSON.stringify({ type: 'tool_result', toolCallId: 'x', toolName: 'Read', output: [] }),
    ].join('\n')
    expect(detectFormat(jsonl)).toBe('jsonl')
  })

  it('detects text for plain prose', () => {
    const text = 'This is a plain text trace.\nWith multiple lines.\nNo JSON here.'
    expect(detectFormat(text)).toBe('text')
  })

  it('returns text for empty input', () => {
    expect(detectFormat('')).toBe('text')
    expect(detectFormat('   \n  ')).toBe('text')
  })

  it('returns text when fewer than 60% of lines are JSON', () => {
    const mixed = [
      JSON.stringify({ type: 'text', text: 'hi' }),
      'plain line',
      'another plain line',
      'yet another',
    ].join('\n')
    expect(detectFormat(mixed)).toBe('text')
  })
})

// ─────────────────────────────────────────────────────────────
// JSONL — compression
// ─────────────────────────────────────────────────────────────

describe('compressTrace — JSONL format', () => {
  const threshold = 100 // low threshold so small test strings trigger extraction

  it('passes through small events unchanged', async () => {
    const event = { type: 'text', text: 'short text' }
    const input = JSON.stringify(event)
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })
    const parsed = JSON.parse(result.compressed.trim())
    expect(parsed.type).toBe('text')
    expect(parsed.text).toBe('short text')
    expect(result.stats.sidecarCount).toBe(0)
  })

  it('extracts large text fields to a sidecar and replaces with a string pointer', async () => {
    const big = bigString(threshold + 50)
    const event = { type: 'text', text: big }
    const input = JSON.stringify(event)
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })

    const parsed = JSON.parse(result.compressed.trim())
    // text field should now be a string sentinel
    expect(typeof parsed.text).toBe('string')
    expect(isStrSidecarPointer(parsed.text)).toBe(true)

    // Sidecar file should contain the original text
    const entry = result.manifest.entries[0]
    const sidecarContent = fs.readFileSync(path.join(sidecarDir(), entry.file), 'utf8')
    expect(sidecarContent).toBe(big)
    expect(result.stats.sidecarCount).toBe(1)
  })

  it('extracts large tool_result output to a sidecar (object SidecarRef)', async () => {
    const largeOutput = [
      {
        type: 'json',
        value: { content: bigString(threshold + 200) },
      },
    ]
    const event = {
      type: 'tool_result',
      toolCallId: 'tc1',
      toolName: 'Read',
      output: largeOutput,
    }
    const input = JSON.stringify(event)
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })

    const parsed = JSON.parse(result.compressed.trim())
    expect(parsed.type).toBe('tool_result')
    // output should be a SidecarRef object
    expect(isSidecarRef(parsed.output)).toBe(true)
    expect((parsed.output as { byteCount: number }).byteCount).toBeGreaterThan(threshold)
    expect(result.stats.sidecarCount).toBe(1)
  })

  it('extracts large reasoning_delta text', async () => {
    const big = bigString(threshold + 50)
    const event = { type: 'reasoning_delta', text: big, runId: 'r1', ancestorRunIds: [] }
    const input = JSON.stringify(event)
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })

    const parsed = JSON.parse(result.compressed.trim())
    expect(isStrSidecarPointer(parsed.text)).toBe(true)
    expect(result.stats.sidecarCount).toBe(1)
  })

  it('produces stable sidecar IDs for identical content', async () => {
    const big = bigString(threshold + 50)
    const event = { type: 'text', text: big }
    const input = JSON.stringify(event)

    const result1 = await compressTrace(input, {
      sidecarDir: sidecarDir() + '1',
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })
    const result2 = await compressTrace(input, {
      sidecarDir: sidecarDir() + '2',
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })

    expect(result1.manifest.entries[0].sidecarId).toBe(result2.manifest.entries[0].sidecarId)
    expect(result1.manifest.entries[0].file).toBe(result2.manifest.entries[0].file)
  })

  it('does not duplicate sidecar files for the same content seen twice', async () => {
    const big = bigString(threshold + 50)
    const eventA = JSON.stringify({ type: 'text', text: big })
    const eventB = JSON.stringify({ type: 'text', text: big }) // same content
    const input = [eventA, eventB].join('\n')

    const dir = sidecarDir()
    await compressTrace(input, {
      sidecarDir: dir,
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('sidecar_'))
    // Both events share the same hash → only one sidecar file
    expect(files.length).toBe(1)
  })

  it('writes a valid manifest.json', async () => {
    const big = bigString(threshold + 50)
    const input = JSON.stringify({ type: 'text', text: big })
    const dir = sidecarDir()
    const result = await compressTrace(input, {
      sidecarDir: dir,
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })

    const manifestPath = path.join(dir, 'manifest.json')
    expect(fs.existsSync(manifestPath)).toBe(true)
    const manifest: SidecarManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(manifest.version).toBe(1)
    expect(manifest.format).toBe('jsonl')
    expect(manifest.threshold).toBe(threshold)
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0].sidecarId).toBe(result.manifest.entries[0].sidecarId)
  })

  it('handles non-JSON lines gracefully by passing them through', async () => {
    const input = 'this is not json\n' + JSON.stringify({ type: 'text', text: 'ok' })
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })
    expect(result.compressed).toContain('this is not json')
  })

  it('reports correct statistics', async () => {
    const big = bigString(threshold + 500)
    const input = JSON.stringify({ type: 'text', text: big })
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'jsonl',
    })
    expect(result.stats.originalBytes).toBeGreaterThan(threshold)
    expect(result.stats.compressedBytes).toBeLessThan(result.stats.originalBytes)
    expect(result.stats.reductionPct).toBeGreaterThan(0)
    expect(result.stats.sidecarCount).toBe(1)
    expect(result.stats.format).toBe('jsonl')
  })
})

// ─────────────────────────────────────────────────────────────
// Plain-text — compression
// ─────────────────────────────────────────────────────────────

describe('compressTrace — plain-text format', () => {
  const threshold = 100

  it('extracts large fenced code blocks', async () => {
    const body = bigString(threshold + 50)
    const input = `Some preamble\n\`\`\`\n${body}\n\`\`\`\nSome epilogue`
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'text',
    })
    expect(result.compressed).toContain('[[SIDECAR:')
    expect(result.compressed).not.toContain(body)
    expect(result.stats.sidecarCount).toBe(1)

    // Sidecar file has the original body
    const entry = result.manifest.entries[0]
    const sidecarContent = fs.readFileSync(path.join(sidecarDir(), entry.file), 'utf8')
    expect(sidecarContent).toBe(body)
  })

  it('extracts large XML-style tool_result blocks', async () => {
    const body = bigString(threshold + 50)
    const input = `Header\n<tool_result>\n${body}\n</tool_result>\nFooter`
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'text',
    })
    expect(result.compressed).toContain('[[SIDECAR:')
    expect(result.stats.sidecarCount).toBe(1)
  })

  it('extracts large label-prefix blocks', async () => {
    const body = bigString(threshold + 50)
    const input = `Result:\n${body}`
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'text',
    })
    expect(result.compressed).toContain('[[SIDECAR:')
    expect(result.stats.sidecarCount).toBe(1)
  })

  it('leaves small blocks intact', async () => {
    const input = '```\nsmall\n```'
    const result = await compressTrace(input, {
      sidecarDir: sidecarDir(),
      threshold,
      summarize: 'none',
      format: 'text',
    })
    expect(result.compressed).toBe(input)
    expect(result.stats.sidecarCount).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
// Heuristic summarisation
// ─────────────────────────────────────────────────────────────

describe('heuristic summarisation', () => {
  it('includes byte count and line count in the summary', async () => {
    const body = 'line1\nline2\nline3\n' + bigString(200)
    const event = { type: 'text', text: body }
    const result = await compressTrace(JSON.stringify(event), {
      sidecarDir: sidecarDir(),
      threshold: 50,
      summarize: 'heuristic',
      format: 'jsonl',
    })
    const entry = result.manifest.entries[0]
    expect(entry.summary).toContain('bytes')
    expect(entry.summary).toContain('lines')
  })
})

// ─────────────────────────────────────────────────────────────
// Restoration — JSONL
// ─────────────────────────────────────────────────────────────

describe('restoreTrace — JSONL', () => {
  it('round-trips text events faithfully', async () => {
    const big = bigString(300)
    const original = JSON.stringify({ type: 'text', text: big, agentId: 'agent-1' })
    const dir = sidecarDir()
    const { compressed } = await compressTrace(original, {
      sidecarDir: dir,
      threshold: 100,
      summarize: 'none',
      format: 'jsonl',
    })
    const restored = restoreTrace(compressed, dir, 'jsonl')
    expect(JSON.parse(restored)).toEqual(JSON.parse(original))
  })

  it('round-trips tool_result events faithfully', async () => {
    const largeOutput = [{ type: 'json', value: { content: bigString(500) } }]
    const original = JSON.stringify({
      type: 'tool_result',
      toolCallId: 'tc99',
      toolName: 'Bash',
      output: largeOutput,
    })
    const dir = sidecarDir()
    const { compressed } = await compressTrace(original, {
      sidecarDir: dir,
      threshold: 100,
      summarize: 'none',
      format: 'jsonl',
    })
    const restored = restoreTrace(compressed, dir, 'jsonl')
    expect(JSON.parse(restored)).toEqual(JSON.parse(original))
  })

  it('round-trips multi-line JSONL with mixed event types', async () => {
    const events = [
      { type: 'start', agentId: 'a1', messageHistoryLength: 0 },
      { type: 'tool_call', toolCallId: 'tc1', toolName: 'Read', input: { file_path: '/foo' } },
      { type: 'tool_result', toolCallId: 'tc1', toolName: 'Read', output: [{ type: 'json', value: { content: bigString(300) } }] },
      { type: 'text', text: bigString(400) },
      { type: 'finish', agentId: 'a1', totalCost: 0.01 },
    ]
    const original = events.map((e) => JSON.stringify(e)).join('\n')
    const dir = sidecarDir()
    const { compressed, stats } = await compressTrace(original, {
      sidecarDir: dir,
      threshold: 100,
      summarize: 'none',
      format: 'jsonl',
    })
    expect(stats.sidecarCount).toBe(2) // tool_result.output + text.text
    const restored = restoreTrace(compressed, dir, 'jsonl')
    const originalLines = original.split('\n').map((l) => JSON.parse(l))
    const restoredLines = restored.split('\n').map((l) => JSON.parse(l))
    expect(restoredLines).toEqual(originalLines)
  })

  it('leaves already-small events unchanged after restore', async () => {
    const event = { type: 'finish', agentId: 'a1', totalCost: 0.005 }
    const original = JSON.stringify(event)
    const dir = sidecarDir()
    const { compressed } = await compressTrace(original, {
      sidecarDir: dir,
      threshold: 100,
      summarize: 'none',
      format: 'jsonl',
    })
    expect(compressed.trim()).toBe(original)
    const restored = restoreTrace(compressed, dir, 'jsonl')
    expect(JSON.parse(restored)).toEqual(event)
  })
})

// ─────────────────────────────────────────────────────────────
// Restoration — plain text
// ─────────────────────────────────────────────────────────────

describe('restoreTrace — plain text', () => {
  it('round-trips fenced code blocks', async () => {
    const body = bigString(300)
    const original = `Header\n\`\`\`python\n${body}\n\`\`\`\nFooter`
    const dir = sidecarDir()
    const { compressed } = await compressTrace(original, {
      sidecarDir: dir,
      threshold: 100,
      summarize: 'none',
      format: 'text',
    })
    expect(compressed).not.toContain(body)
    const restored = restoreTrace(compressed, dir, 'text')
    expect(restored).toBe(original)
  })

  it('round-trips XML-style blocks', async () => {
    const body = bigString(300)
    const original = `<result>\n${body}\n</result>`
    const dir = sidecarDir()
    const { compressed } = await compressTrace(original, {
      sidecarDir: dir,
      threshold: 100,
      summarize: 'none',
      format: 'text',
    })
    const restored = restoreTrace(compressed, dir, 'text')
    expect(restored).toBe(original)
  })
})

// ─────────────────────────────────────────────────────────────
// Auto-detection in restoreTrace
// ─────────────────────────────────────────────────────────────

describe('auto-detection', () => {
  it('auto-detects jsonl and restores correctly', async () => {
    const big = bigString(300)
    const original = JSON.stringify({ type: 'text', text: big })
    const dir = sidecarDir()
    const { compressed } = await compressTrace(original, {
      sidecarDir: dir,
      threshold: 100,
      summarize: 'none',
      format: 'jsonl',
    })
    const restored = restoreTrace(compressed, dir) // format defaults to 'auto'
    expect(JSON.parse(restored)).toEqual({ type: 'text', text: big })
  })
})

// ─────────────────────────────────────────────────────────────
// Stable pointer correctness
// ─────────────────────────────────────────────────────────────

describe('stable pointers', () => {
  it('sidecar file name matches SHA-256 of content', async () => {
    const big = bigString(300)
    const dir = sidecarDir()
    const result = await compressTrace(JSON.stringify({ type: 'text', text: big }), {
      sidecarDir: dir,
      threshold: 100,
      summarize: 'none',
      format: 'jsonl',
    })
    const entry = result.manifest.entries[0]
    const expectedId = sha256Prefix(big)
    expect(entry.sidecarId).toBe(expectedId)
    expect(entry.file).toBe(`sidecar_${expectedId}.txt`)
  })
})
