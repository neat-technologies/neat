import { describe, expect, it } from 'vitest'
import { fixActionFor, rigorousFixAction, type FixActionInput } from '../src/advisories/fix-action.js'

function input(over: Partial<FixActionInput>): FixActionInput {
  return { fixedInByAdvisory: [], installed: '1.0.0', ecosystem: 'npm', scope: 'direct', introducedBy: [], ...over }
}

describe('fixActionFor (G2 fix loop)', () => {
  it('bumps to the earliest same-major fixed release above the installed version', () => {
    const a = fixActionFor(input({ installed: '1.2.0', fixedInByAdvisory: [['1.5.0', '1.3.0', '2.0.0']] }))
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '1.3.0', via: [] })
  })

  it('keeps the breaking fix (majorTo) when the only fix is a major bump', () => {
    const a = fixActionFor(input({ installed: '1.2.0', fixedInByAdvisory: [['2.0.0']] }))
    expect(a).toEqual({
      kind: 'remove-or-replace',
      reason: expect.stringMatching(/major-version bump/) as unknown as string,
      majorTo: '2.0.0',
    })
  })

  it('removes-or-replaces (no majorTo) when the advisories list no fixed release', () => {
    expect(fixActionFor(input({ fixedInByAdvisory: [[]] }))).toEqual({
      kind: 'remove-or-replace',
      reason: 'the advisories list no fixed release',
    })
  })

  it('removes-or-replaces when no fixed release is newer than the installed version', () => {
    const a = fixActionFor(input({ installed: '2.0.0', fixedInByAdvisory: [['1.5.0']] }))
    expect(a.kind).toBe('remove-or-replace')
    if (a.kind === 'remove-or-replace') expect(a.majorTo).toBeUndefined()
  })

  it('treats a 0.x minor bump as breaking (caret rules), keeping majorTo', () => {
    expect(fixActionFor(input({ installed: '0.2.1', fixedInByAdvisory: [['0.3.0']] }))).toMatchObject({
      kind: 'remove-or-replace',
      majorTo: '0.3.0',
    })
  })

  it('allows a 0.x patch bump within the same minor', () => {
    expect(fixActionFor(input({ installed: '0.2.1', fixedInByAdvisory: [['0.2.4']] }))).toEqual({
      kind: 'bump-to-fixedIn',
      to: '0.2.4',
      via: [],
    })
  })

  it('names the parent(s) via for a transitive dependency', () => {
    const a = fixActionFor(
      input({ installed: '1.2.0', fixedInByAdvisory: [['1.3.0']], scope: 'transitive', introducedBy: ['left-pad@1.0.0'] }),
    )
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '1.3.0', via: ['left-pad@1.0.0'] })
  })

  it('transitive with no known parent carries an empty via (the renderer says "override")', () => {
    const a = fixActionFor(input({ installed: '1.2.0', fixedInByAdvisory: [['1.3.0']], scope: 'transitive', introducedBy: [] }))
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '1.3.0', via: [] })
  })

  it("aggregates across a dependency's advisories: the target clears all of them", () => {
    const a = fixActionFor(input({ installed: '4.17.15', fixedInByAdvisory: [['4.17.19'], ['4.17.21']] }))
    expect(a).toEqual({ kind: 'bump-to-fixedIn', to: '4.17.21', via: [] })
  })

  it('removes-or-replaces when one advisory has no fix above the installed version', () => {
    expect(fixActionFor(input({ installed: '1.2.0', fixedInByAdvisory: [['1.3.0'], []] })).kind).toBe('remove-or-replace')
  })

  it('needs a major bump when clearing all advisories crosses a major', () => {
    expect(fixActionFor(input({ installed: '1.2.0', fixedInByAdvisory: [['1.3.0'], ['2.1.0']] }))).toMatchObject({
      kind: 'remove-or-replace',
      majorTo: '2.1.0',
    })
  })

  it('PyPI: same release[0] is non-breaking', () => {
    expect(fixActionFor(input({ ecosystem: 'PyPI', installed: '2.25.0', fixedInByAdvisory: [['2.31.0']] }))).toEqual({
      kind: 'bump-to-fixedIn',
      to: '2.31.0',
      via: [],
    })
  })

  it('PyPI: a different release[0] is a major bump', () => {
    expect(fixActionFor(input({ ecosystem: 'PyPI', installed: '2.25.0', fixedInByAdvisory: [['3.0.0']] }))).toMatchObject({
      kind: 'remove-or-replace',
      majorTo: '3.0.0',
    })
  })

  it('Go: a bump within the same major is non-breaking', () => {
    expect(fixActionFor(input({ ecosystem: 'Go', installed: 'v1.2.0', fixedInByAdvisory: [['v1.9.0']] }))).toEqual({
      kind: 'bump-to-fixedIn',
      to: 'v1.9.0',
      via: [],
    })
  })

  it('Go: a v0 bump stays on the same import path (x/net 0.60 -> 0.62)', () => {
    expect(fixActionFor(input({ ecosystem: 'Go', installed: 'v0.60.0', fixedInByAdvisory: [['v0.62.0']] }))).toEqual({
      kind: 'bump-to-fixedIn',
      to: 'v0.62.0',
      via: [],
    })
  })

  it('Go: v0 -> v1 stays on the same import path (the /vN suffix starts at v2)', () => {
    expect(fixActionFor(input({ ecosystem: 'Go', installed: 'v0.9.0', fixedInByAdvisory: [['v1.0.0']] }))).toEqual({
      kind: 'bump-to-fixedIn',
      to: 'v1.0.0',
      via: [],
    })
  })

  it('Go: crossing to v2+ is a new module import path, so remove-or-replace', () => {
    const a = fixActionFor(input({ ecosystem: 'Go', installed: 'v1.5.0', fixedInByAdvisory: [['v2.0.0']] }))
    expect(a.kind).toBe('remove-or-replace')
    if (a.kind === 'remove-or-replace') {
      expect(a.majorTo).toBe('v2.0.0')
      expect(a.reason).toMatch(/new major module path/)
    }
  })

  it('coerces a loose semver so the comparison still lands', () => {
    expect(fixActionFor(input({ installed: '1.2', fixedInByAdvisory: [['1.4']] }))).toEqual({
      kind: 'bump-to-fixedIn',
      to: '1.4',
      via: [],
    })
  })

  it('stays conservative (remove-or-replace) when a version cannot be parsed', () => {
    expect(fixActionFor(input({ installed: 'not-a-version', fixedInByAdvisory: [['also-bad']] })).kind).toBe(
      'remove-or-replace',
    )
  })
})

describe('rigorousFixAction (G2, matcher-cleared target)', () => {
  const base = { installed: '2.0.0', ecosystem: 'npm', scope: 'direct' as const, introducedBy: [] as string[] }

  it('takes the lowest candidate the matcher clears, skipping one inside a re-affected range', () => {
    // advisory A re-affects [2.8, 2.12); advisory B is fixed at 2.10.0. 2.10.0, the
    // max of the per-advisory minimal fixes, is back inside A's later range, so the
    // predicate (standing in for the matcher) clears only 2.12.0.
    const cleared = new Set(['2.12.0'])
    expect(
      rigorousFixAction({ ...base, candidates: ['2.5.0', '2.12.0', '2.10.0'], clears: (v) => cleared.has(v) }),
    ).toEqual({ kind: 'bump-to-fixedIn', to: '2.12.0', via: [] })
  })

  it('ignores candidates at or below the installed version and de-dupes', () => {
    expect(rigorousFixAction({ ...base, candidates: ['1.0.0', '2.0.0', '2.4.0', '2.4.0'], clears: () => true })).toEqual({
      kind: 'bump-to-fixedIn',
      to: '2.4.0',
      via: [],
    })
  })

  it('remove-or-replace when no candidate clears every advisory', () => {
    expect(rigorousFixAction({ ...base, candidates: ['2.5.0', '2.10.0'], clears: () => false })).toEqual({
      kind: 'remove-or-replace',
      reason: 'no fixed release clears every advisory on this dependency',
    })
  })

  it('remove-or-replace (no majorTo) when the advisories list no fixed release', () => {
    expect(rigorousFixAction({ ...base, candidates: [], clears: () => true })).toEqual({
      kind: 'remove-or-replace',
      reason: 'the advisories list no fixed release',
    })
  })

  it('keeps the breaking fix as majorTo when the clearing target crosses a major', () => {
    expect(
      rigorousFixAction({ ...base, installed: '1.2.0', candidates: ['1.5.0', '2.2.0'], clears: (v) => v === '2.2.0' }),
    ).toMatchObject({ kind: 'remove-or-replace', majorTo: '2.2.0' })
  })

  it('carries the parent via for a transitive dependency', () => {
    expect(
      rigorousFixAction({
        ...base,
        scope: 'transitive',
        introducedBy: ['express@4.0.0'],
        candidates: ['2.12.0'],
        clears: () => true,
      }),
    ).toEqual({ kind: 'bump-to-fixedIn', to: '2.12.0', via: ['express@4.0.0'] })
  })
})
