import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

describe('agent skill copies', () => {
  it('matches the canonical skill and MCP tool descriptions', () => {
    const script = join(__dirname, '../../../../scripts/sync-agent-skill.mjs')
    expect(() => execFileSync('node', [script, '--check'])).not.toThrow()
  })
})
