import { describe, expect, it } from 'bun:test'

import { parseEnvFile } from '../load-env'

describe('parseEnvFile', () => {
  it('parses dotenv-style assignments and ignores comments', () => {
    expect(parseEnvFile(`
# comment
OPENAI_API_KEY=abc
export CLAUDE_CODE_KEY="def"
EMPTY=
QUOTED='ghi'
INVALID LINE
`)).toEqual([
      ['OPENAI_API_KEY', 'abc'],
      ['CLAUDE_CODE_KEY', 'def'],
      ['EMPTY', ''],
      ['QUOTED', 'ghi'],
    ])
  })

  it('strips inline comments without breaking quoted hashes', () => {
    expect(parseEnvFile(`
OPENAI_API_KEY=sk-live # local key
export CLAUDE_CODE_KEY="anthropic-key" # note
URL_WITH_HASH=https://example.com/#fragment
QUOTED_HASH="#still-a-value"
`)).toEqual([
      ['OPENAI_API_KEY', 'sk-live'],
      ['CLAUDE_CODE_KEY', 'anthropic-key'],
      ['URL_WITH_HASH', 'https://example.com/#fragment'],
      ['QUOTED_HASH', '#still-a-value'],
    ])
  })
})
