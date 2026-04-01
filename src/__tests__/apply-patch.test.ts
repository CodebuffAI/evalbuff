import { describe, expect, test } from 'bun:test'

import { applyPatch } from '../apply-patch'

describe('applyPatch', () => {
  test('applies a simple line replacement', () => {
    const result = applyPatch(
      'const a = 1\n',
      '@@ -1,1 +1,1 @@\n-const a = 1\n+const a = 2\n',
    )
    expect(result).toBe('const a = 2\n')
  })

  test('applies patch with bare @@ header', () => {
    const input = ['line1', 'line2', 'line3', ''].join('\n')
    const diff = ['@@', ' line1', '-line2', '+line2 changed', ' line3', ''].join('\n')
    const result = applyPatch(input, diff)
    expect(result).toBe(['line1', 'line2 changed', 'line3', ''].join('\n'))
  })

  test('applies patch when hunk header ranges are incorrect', () => {
    const input = ['line1', 'line2', 'line3', ''].join('\n')
    const diff = ['@@ -39,6 +39,39 @@', ' line1', '-line2', '+line2 changed', ' line3', ''].join('\n')
    const result = applyPatch(input, diff)
    expect(result).toBe(['line1', 'line2 changed', 'line3', ''].join('\n'))
  })

  test('applies patch with malformed hunk header', () => {
    const input = ['line1', 'line2', 'line3', ''].join('\n')
    const diff = ['@@ -1 +1 @@', ' line1', '-line2', '+line2 changed', ' line3', ''].join('\n')
    const result = applyPatch(input, diff)
    expect(result).toBe(['line1', 'line2 changed', 'line3', ''].join('\n'))
  })

  test('applies patch with codex-style anchor header', () => {
    const input = ['before', 'target', 'after', ''].join('\n')
    const diff = ['@@ target', '+inserted', ' after', ''].join('\n')
    const result = applyPatch(input, diff)
    expect(result).toBe(['before', 'target', 'inserted', 'after', ''].join('\n'))
  })

  test('preserves CRLF line endings', () => {
    const result = applyPatch(
      'line1\r\nline2\r\n',
      '@@ -1,2 +1,2 @@\n-line1\n-line2\n+line1 changed\n+line2\n',
    )
    expect(result).toContain('line1 changed')
    expect(result).toContain('\r\n')
  })

  test('does not force CRLF when original has mixed line endings', () => {
    const result = applyPatch(
      'line1\r\nline2\n',
      '@@ -1,2 +1,2 @@\n-line1\n-line2\n+line1 changed\n+line2\n',
    )
    expect(result).toContain('line1 changed\nline2\n')
    expect(result).not.toContain('line1 changed\r\nline2\r\n')
  })

  test('extracts diff from markdown fenced block', () => {
    const diff = [
      'Please apply this patch:',
      '```diff',
      '@@ -1,1 +1,1 @@',
      '-const a = 1',
      '+const a = 2',
      '```',
    ].join('\n')
    const result = applyPatch('const a = 1\n', diff)
    expect(result).toContain('const a = 2')
  })

  test('extracts diff from CRLF markdown fenced block', () => {
    const diff = 'Patch below:\r\n```diff\r\n@@ -1,1 +1,1 @@\r\n-const a = 1\r\n+const a = 2\r\n```'
    const result = applyPatch('const a = 1\r\n', diff)
    expect(result).toBe('const a = 2\r\n')
  })

  test('throws on context mismatch', () => {
    expect(() =>
      applyPatch('hello\n', '@@ -1,1 +1,1 @@\n-goodbye\n+hi\n'),
    ).toThrow('Failed to apply patch')
  })

  test('throws when patch produces no changes', () => {
    expect(() =>
      applyPatch('hello\n', '@@ -1,1 +1,1 @@\n-hello\n+hello\n'),
    ).toThrow('Failed to apply patch')
  })

  test('applies multiple hunks', () => {
    const input = ['a', 'b', 'c', 'd', 'e', ''].join('\n')
    const diff = [
      '@@',
      '-a',
      '+A',
      ' b',
      ' c',
      ' d',
      '-e',
      '+E',
    ].join('\n')
    const result = applyPatch(input, diff)
    expect(result).toBe(['A', 'b', 'c', 'd', 'E', ''].join('\n'))
  })

  test('applies insertion-only patch', () => {
    const input = ['first', 'last', ''].join('\n')
    const diff = ['@@', ' first', '+middle', ' last', ''].join('\n')
    const result = applyPatch(input, diff)
    expect(result).toBe(['first', 'middle', 'last', ''].join('\n'))
  })

  test('applies deletion-only patch', () => {
    const input = ['first', 'middle', 'last', ''].join('\n')
    const diff = ['@@', ' first', '-middle', ' last', ''].join('\n')
    const result = applyPatch(input, diff)
    expect(result).toBe(['first', 'last', ''].join('\n'))
  })

  test('handles fuzzy matching with trailing whitespace', () => {
    const input = 'hello   \nworld\n'
    const diff = '@@\n-hello\n+hi\n world\n'
    const result = applyPatch(input, diff)
    expect(result).toContain('hi')
  })

  test('works with file missing trailing newline', () => {
    const result = applyPatch(
      'const a = 1',
      '@@ -1,1 +1,1 @@\n-const a = 1\n+const a = 2\n',
    )
    expect(result).toContain('const a = 2')
  })

  test('applies a realistic multi-line patch', () => {
    const input = [
      'import React from "react"',
      '',
      'function App() {',
      '  return (',
      '    <div>',
      '      <h1>Hello</h1>',
      '      <OldComponent />',
      '    </div>',
      '  )',
      '}',
      '',
      'export default App',
      '',
    ].join('\n')

    const diff = [
      '@@',
      '       <h1>Hello</h1>',
      '-      <OldComponent />',
      '+      <NewComponent />',
      '     </div>',
    ].join('\n')

    const result = applyPatch(input, diff)
    expect(result).toContain('<NewComponent />')
    expect(result).not.toContain('<OldComponent />')
    expect(result).toContain('import React from "react"')
    expect(result).toContain('export default App')
  })
})
