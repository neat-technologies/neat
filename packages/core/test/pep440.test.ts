import { describe, expect, it } from 'vitest'
import { comparePep440, parsePep440 } from '../src/advisories/pep440.js'

// PEP 440 ordering (advisory-cache.md §3). The expected order below is what
// Python's `packaging.version.Version` gives for the same strings.

const ORDERED = [
  '0.9', '0.9.post2', '1.0.dev0', '1.0.dev1', '1.0a1.dev1', '1.0a1', '1.0a1.post1', '1.0a2', '1.0b1',
  '1.0rc1.dev3', '1.0rc1', '1.0c2', '1.0', '1.0+abc', '1.0+local.1', '1.0+local.1.x', '1.0+local.2',
  '1.0.post1.dev1', '1.0.post1', '1.0.1', '1.1', '3.1.4', '3.1.10', '2!0.1',
]

describe('PEP 440 ordering', () => {
  it('sorts the way packaging.version does', () => {
    const shuffled = [...ORDERED].reverse()
    const sorted = shuffled.sort((a, b) => comparePep440(parsePep440(a)!, parsePep440(b)!))
    expect(sorted).toEqual(ORDERED)
  })

  it('treats equivalent spellings as equal', () => {
    for (const [a, b] of [['1.0', '1.0.0'], ['1.0-1', '1.0.post1'], ['1.0c2', '1.0rc2'], ['1.0alpha1', '1.0a1'], ['v1.0', '1.0']]) {
      expect(comparePep440(parsePep440(a!)!, parsePep440(b!)!)).toBe(0)
    }
  })

  it('rejects strings that are not PEP 440', () => {
    expect(parsePep440('not-a-version')).toBeNull()
    expect(parsePep440('1.0.0-beta+')).toBeNull()
  })
})
