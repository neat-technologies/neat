import { describe, expect, it } from 'vitest'
import { fixActionFor, type FixActionInput } from '../src/advisories/fix-action.js'

function input(over: Partial<FixActionInput>): FixActionInput {
  return { fixedIn: [], installed: '1.0.0', ecosystem: 'npm', scope: 'direct', introducedBy: [], ...over }
}

describe('fixActionFor (G2 fix loop)', () => {
  it('bumps to the earliest same-major fixed release above the installed version', () => {
    const a = fixActionFor(input({ installed: '1.2.0', fixedIn: ['1.5.0', '1.3.0', '2.0.0'] }))
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '1.3.0', via: [] })
  })

  it('removes-or-replaces when the only fix is a major bump', () => {
    const a = fixActionFor(input({ installed: '1.2.0', fixedIn: ['2.0.0'] }))
    expect(a.kind).toBe('remove-or-replace')
    if (a.kind === 'remove-or-replace') expect(a.reason).toMatch(/major-version bump/)
  })

  it('removes-or-replaces when the advisory lists no fixed release', () => {
    expect(fixActionFor(input({ fixedIn: [] }))).toEqual({
      kind: 'remove-or-replace',
      reason: 'the advisory lists no fixed release',
    })
  })

  it('removes-or-replaces when no fixed release is newer than the installed version', () => {
    const a = fixActionFor(input({ installed: '2.0.0', fixedIn: ['1.5.0'] }))
    expect(a.kind).toBe('remove-or-replace')
    if (a.kind === 'remove-or-replace') expect(a.reason).toMatch(/newer than the installed/)
  })

  it('treats a 0.x minor bump as breaking (caret rules)', () => {
    const a = fixActionFor(input({ installed: '0.2.1', fixedIn: ['0.3.0'] }))
    expect(a.kind).toBe('remove-or-replace')
  })

  it('allows a 0.x patch bump within the same minor', () => {
    const a = fixActionFor(input({ installed: '0.2.1', fixedIn: ['0.2.4'] }))
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '0.2.4', via: [] })
  })

  it('names the parent(s) to bump for a transitive dependency', () => {
    const a = fixActionFor(
      input({ installed: '1.2.0', fixedIn: ['1.3.0'], scope: 'transitive', introducedBy: ['left-pad@1.0.0'] }),
    )
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '1.3.0', via: ['left-pad@1.0.0'] })
  })

  it('PyPI: same release[0] is a non-breaking bump', () => {
    const a = fixActionFor(input({ ecosystem: 'PyPI', installed: '2.25.0', fixedIn: ['2.31.0'] }))
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '2.31.0', via: [] })
  })

  it('PyPI: a different release[0] is a major bump', () => {
    const a = fixActionFor(input({ ecosystem: 'PyPI', installed: '2.25.0', fixedIn: ['3.0.0'] }))
    expect(a.kind).toBe('remove-or-replace')
  })

  it('Go: any fixed release for this module node is same-major (major is in the path)', () => {
    const a = fixActionFor(input({ ecosystem: 'Go', installed: '1.2.0', fixedIn: ['1.9.0'] }))
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '1.9.0', via: [] })
  })

  it('coerces a loose semver so the comparison still lands', () => {
    const a = fixActionFor(input({ installed: '1.2', fixedIn: ['1.4'] }))
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '1.4', via: [] })
  })

  it('stays conservative (remove-or-replace) when a version cannot be parsed', () => {
    const a = fixActionFor(input({ installed: 'not-a-version', fixedIn: ['also-bad'] }))
    expect(a.kind).toBe('remove-or-replace')
  })
})
