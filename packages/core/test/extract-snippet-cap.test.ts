import { describe, it, expect } from 'vitest'
import { snippet } from '../src/extract/calls/shared.js'
import { IGNORED_DIRS } from '../src/extract/shared.js'

// static-extraction.md §evidence — `snippet?: string // small source fragment,
// max ~120 chars`. The contract always said that; the helper didn't enforce it,
// so a snippet was the whole source line. A line has no bound: one minified
// bundle is one line per file, so every edge naming it carried the file (#1254).

describe('snippet', () => {
  it('returns a short line whole, trimmed', () => {
    const src = 'const a = 1\n  await fetch("https://api.example.com")  \nconst b = 2'
    expect(snippet(src, 2)).toBe('await fetch("https://api.example.com")')
  })

  it('caps a long line and says it cut it', () => {
    const long = `const x = "${'y'.repeat(5000)}"`
    const out = snippet(`first\n${long}`, 2)
    expect(out.length).toBeLessThan(200)
    expect(out).toContain('…')
    expect(out).toMatch(/\(\+\d+ chars\)$/)
    expect(out.startsWith('const x = "yyy')).toBe(true)
  })

  it('bounds a minified one-liner — the shape that could not be serialized', () => {
    // 200 KB on one line, the real failing case. Every symbol in such a file
    // gets a containment edge, and each one used to carry the whole line.
    let line = ''
    let i = 0
    while (line.length < 200 * 1024) line += `function m${i++}(a,b){return a+b}`
    const out = snippet(line, 1)
    expect(line.length).toBeGreaterThan(200_000)
    expect(out.length).toBeLessThan(200)
  })

  it('is stable for a missing line rather than throwing', () => {
    expect(snippet('only one line', 99)).toBe('')
  })
})

describe('IGNORED_DIRS', () => {
  it('carries both halves of the Next pair, not just the dot one', () => {
    // `.next` was listed and `_next` — the emitted/exported half — was not, so
    // a built bundle walked in as first-party source.
    expect(IGNORED_DIRS.has('.next')).toBe(true)
    expect(IGNORED_DIRS.has('_next')).toBe(true)
  })

  it('skips the agent worktree directory', () => {
    // `.claude/worktrees/` holds a full checkout per session; walking it
    // re-extracts the whole repo once per worktree.
    expect(IGNORED_DIRS.has('.claude')).toBe(true)
  })
})
