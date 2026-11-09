import { describe, expect, it } from 'vitest'
import { computeFixDiff, fixDiffPair, isPackageSource } from '../src/advisories/fixdiff.js'

// The fix-diff (ADR-274, advisory-cache.md §4): the symbols a fix release
// changed, from NEAT's own extraction over two releases. Synthetic in-memory
// file sets, so the test is deterministic and hits no network.

const files = (m: Record<string, string>) => new Map(Object.entries(m))
const names = (d: ReturnType<typeof computeFixDiff>) => d.changed.map((c) => c.symbol).sort()
const byName = (d: ReturnType<typeof computeFixDiff>) => Object.fromEntries(d.changed.map((c) => [c.symbol, c]))

describe('computeFixDiff', () => {
  const V = files({
    'src/a.js': [
      'function template(s) { return s }',
      'function trim(s) { return s.trim() }',
      'function helper(x) {',
      '  // a comment',
      '  return x',
      '}',
      'function gone() { return 0 }',
      'class Box { open() { return 1 } }',
    ].join('\n'),
    'src/b.js': 'function outer(a) { function inner(b) { return b } return inner(a) }',
    'test/a.test.js': 'function shouldSkip() { return 1 }',
    'docs/x.js': 'function alsoSkip() { return 1 }',
  })
  const F = files({
    'src/a.js': [
      'function template(s) { return eval(s) }', // body changed
      'function trim(s) { return s.trim() }', // unchanged
      'function helper(x) { /* different comment */ return x }', // only a comment changed
      // gone() removed
      'function added(y) { return y }', // new
      'class Box { open() { return 2 } }', // method body changed
    ].join('\n'),
    'src/b.js': 'function outer(a) { function inner(b) { return b + 1 } return inner(a) }', // only inner changed
    'test/a.test.js': 'function shouldSkip() { return 999 }', // in a test file: ignored
    'docs/x.js': 'function alsoSkip() { return 2 }', // in docs: ignored
  })

  it('reports modified bodies, new and removed symbols; ignores comment-only and whitespace churn', () => {
    const d = computeFixDiff({ version: '1.0.0', files: V }, { version: '1.0.1', files: F }, '')
    expect(names(d)).toEqual(['Box.open', 'added', 'gone', 'inner', 'template'])
    const by = byName(d)
    expect(by['template'].status).toBe('modified')
    expect(by['added'].status).toBe('new')
    expect(by['gone'].status).toBe('removed')
    // helper changed only a comment, trim is identical: neither appears.
    expect(by['helper']).toBeUndefined()
    expect(by['trim']).toBeUndefined()
  })

  it('attributes a nested change to the inner symbol, not its parent (own-tokens, not nested)', () => {
    const d = byName(computeFixDiff({ version: '1', files: V }, { version: '2', files: F }, ''))
    expect(d['inner'].status).toBe('modified')
    expect(d['outer']).toBeUndefined()
  })

  it('excludes the class itself but keeps its changed method', () => {
    const d = byName(computeFixDiff({ version: '1', files: V }, { version: '2', files: F }, ''))
    expect(d['Box']).toBeUndefined()
    expect(d['Box.open'].kind).toBe('method')
  })

  it('skips tests, docs, vendored and build output', () => {
    expect(isPackageSource('src/a.js')).toBe(true)
    for (const p of ['test/a.test.js', 'docs/x.js', 'a.test.js', 'vendor/x.js', 'node_modules/x/i.js', 'dist/i.js', 'x.min.js', 'types.d.ts', 'pkg_test.go', 'test_x.py']) {
      expect(isPackageSource(p), p).toBe(false)
    }
  })

  it('namedInAdvisory flags the symbols the advisory text names, as a hint only', () => {
    const d = byName(computeFixDiff({ version: '1', files: V }, { version: '2', files: F }, 'The template function allows code injection.'))
    expect(d['template'].namedInAdvisory).toBe(true)
    expect(d['added'].namedInAdvisory).toBe(false)
    // every symbol is reported either way: the flag ranks, it never filters.
    expect(Object.keys(d).length).toBe(5)
  })

  it('is deterministic: same inputs, same output, inputs untouched', () => {
    const snapshot = JSON.stringify([...V, ...F])
    expect(computeFixDiff({ version: '1', files: V }, { version: '2', files: F }, 'x')).toEqual(
      computeFixDiff({ version: '1', files: V }, { version: '2', files: F }, 'x'),
    )
    expect(JSON.stringify([...V, ...F])).toBe(snapshot)
  })

  it('a Python docstring change alone is not a modification (contract §4)', () => {
    const src = (doc: string, body: string) =>
      files({
        'm/x.py': `def f(a):\n    ${doc}\n    return ${body}\n`,
        'm/c.py': `class C:\n    ${doc}\n    def g(self):\n        return 1\n`,
      })
    const v = src('"""old doc"""', 'a')
    // docstring-only change, in both the function body and the class body
    const docOnly = src('"""a completely different docstring"""', 'a')
    expect(computeFixDiff({ version: '1', files: v }, { version: '2', files: docOnly }, '').changed).toEqual([])
    // a real body change is still caught
    const bodyChange = src('"""old doc"""', 'a + 1')
    expect(byName(computeFixDiff({ version: '1', files: v }, { version: '2', files: bodyChange }, ''))['f'].status).toBe('modified')
  })

  it('a Python fix: type-annotation-only churn is ignored, a real change is caught', () => {
    const pv = files({ 'jinja2/filters.py': 'def do_xmlattr(d):\n    return render(d)\n' })
    const pf = files({ 'jinja2/filters.py': 'def do_xmlattr(d: dict) -> str:\n    return render(escape(d))\n' })
    // Advisory names the FILTER ("xmlattr"), not the function symbol ("do_xmlattr"):
    // the function still lands in the changed set via the diff; namedInAdvisory is
    // literal on the symbol name, so the hint doesn't fire. A hint miss never drops
    // the finding.
    const d = byName(computeFixDiff({ version: '3.1.3', files: pv }, { version: '3.1.4', files: pf }, 'The xmlattr filter is vulnerable'))
    expect(d['do_xmlattr'].status).toBe('modified')
    expect(d['do_xmlattr'].namedInAdvisory).toBe(false)
    // When the advisory does name the function, the hint fires.
    const d2 = byName(computeFixDiff({ version: '3.1.3', files: pv }, { version: '3.1.4', files: pf }, 'A flaw in do_xmlattr escapes keys incorrectly'))
    expect(d2['do_xmlattr'].namedInAdvisory).toBe(true)
  })
})

describe('fixDiffPair', () => {
  it('npm: newest stable below the fixed version, skipping prereleases', () => {
    expect(fixDiffPair('npm', ['4.17.18', '4.17.19', '4.17.20', '4.17.21', '5.0.0-rc.1'], '4.17.21', '0')).toEqual({
      from: '4.17.20',
      to: '4.17.21',
    })
  })

  it('npm: null when the prior stable sits below the introduced bound', () => {
    expect(fixDiffPair('npm', ['1.0.0', '1.5.0', '2.0.0'], '1.5.0', '1.2.0')).toBeNull()
  })

  it('npm: null when there is no prior release', () => {
    expect(fixDiffPair('npm', ['1.0.0'], '1.0.0', '0')).toBeNull()
  })

  it('PyPI: uses PEP 440 ordering and skips prereleases', () => {
    expect(fixDiffPair('PyPI', ['3.1.2', '3.1.3', '3.1.4', '3.2.0rc1'], '3.1.4', '0')).toEqual({
      from: '3.1.3',
      to: '3.1.4',
    })
  })
})
