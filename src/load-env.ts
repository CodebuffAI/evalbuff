import fs from 'fs'
import path from 'path'

const ENV_FILES = ['.env.local', '.env']

function stripInlineComment(rawValue: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < rawValue.length; i++) {
    const ch = rawValue[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\') {
      escaped = true
      continue
    }

    if (quote) {
      if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (ch === '#' && i > 0 && /\s/.test(rawValue[i - 1])) {
      return rawValue.slice(0, i).trimEnd()
    }
  }

  return rawValue.trim()
}

export function parseEnvFile(content: string): Array<[string, string]> {
  const entries: Array<[string, string]> = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue

    const [, key, rawValue] = match
    let value = stripInlineComment(rawValue.trim())

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    entries.push([key, value])
  }

  return entries
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return

  const content = fs.readFileSync(filePath, 'utf-8')
  for (const [key, value] of parseEnvFile(content)) {
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

for (const fileName of ENV_FILES) {
  loadEnvFile(path.join(process.cwd(), fileName))
}
