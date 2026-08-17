import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runClaudeCommand,
  NEAT_SECTION_HEADING,
  neatSection,
} from '../src/claude-cli.js'

let dir: string
let mdPath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-claude-'))
  mdPath = path.join(dir, 'CLAUDE.md')
  process.env.NEAT_CLAUDE_MD = mdPath
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env.NEAT_CLAUDE_MD
  await fs.rm(dir, { recursive: true, force: true })
})

function countSections(text: string): number {
  return text.split('\n').filter((l) => l.replace(/\s+$/, '') === NEAT_SECTION_HEADING).length
}

describe('neat claude install/uninstall (ADR-198)', () => {
  it('install creates CLAUDE.md with a single `## neat` section carrying the query-first directive', async () => {
    const code = await runClaudeCommand(['install'])
    expect(code).toBe(0)
    const text = await fs.readFile(mdPath, 'utf8')
    expect(countSections(text)).toBe(1)
    // The directive names the plain-language door and the query-first order.
    expect(text).toContain('neat ask')
    expect(text).toMatch(/before Read/i)
  })

  it('install is idempotent — a second run writes byte-identical content, never a duplicate section', async () => {
    await runClaudeCommand(['install'])
    const first = await fs.readFile(mdPath, 'utf8')
    await runClaudeCommand(['install'])
    const second = await fs.readFile(mdPath, 'utf8')
    expect(second).toBe(first)
    expect(countSections(second)).toBe(1)
  })

  it('install preserves the user\'s own CLAUDE.md content around its section', async () => {
    const preamble = '# My project\n\nSome house rules.\n'
    const trailing = '\n## other section\n\nkeep me.\n'
    await fs.writeFile(mdPath, preamble + trailing, 'utf8')

    await runClaudeCommand(['install'])
    const text = await fs.readFile(mdPath, 'utf8')
    expect(text).toContain('# My project')
    expect(text).toContain('Some house rules.')
    expect(text).toContain('## other section')
    expect(text).toContain('keep me.')
    expect(countSections(text)).toBe(1)

    // Re-running still replaces only NEAT's own section (idempotent in place).
    await runClaudeCommand(['install'])
    const again = await fs.readFile(mdPath, 'utf8')
    expect(again).toBe(text)
    expect(countSections(again)).toBe(1)
  })

  it('uninstall removes the `## neat` section and leaves the rest intact', async () => {
    const other = '# My project\n\n## other section\n\nkeep me.\n'
    await fs.writeFile(mdPath, other, 'utf8')
    await runClaudeCommand(['install'])
    expect(countSections(await fs.readFile(mdPath, 'utf8'))).toBe(1)

    const code = await runClaudeCommand(['uninstall'])
    expect(code).toBe(0)
    const text = await fs.readFile(mdPath, 'utf8')
    expect(countSections(text)).toBe(0)
    expect(text).toContain('## other section')
    expect(text).toContain('keep me.')
  })

  it('uninstall on a file without the section is a no-op success', async () => {
    await fs.writeFile(mdPath, '# just mine\n', 'utf8')
    const code = await runClaudeCommand(['uninstall'])
    expect(code).toBe(0)
    expect(await fs.readFile(mdPath, 'utf8')).toBe('# just mine\n')
  })

  it('print emits the section without touching any file', async () => {
    const code = await runClaudeCommand(['print'])
    expect(code).toBe(0)
    // No CLAUDE.md written by print.
    await expect(fs.readFile(mdPath, 'utf8')).rejects.toThrow()
    expect(neatSection()).toContain(NEAT_SECTION_HEADING)
  })
})
