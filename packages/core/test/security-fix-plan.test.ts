import { describe, it, expect } from 'vitest'
import type { SecurityCard, SecurityFixAction } from '@neat.is/types'
import { classify, humanPlan } from '../src/security/fix-plan.js'

// A minimal security card carrying just what the planner reads: the dependency and
// its reconciled fix.action.
function card(name: string, version: string, action: SecurityFixAction | null, advisory = 'GHSA-a'): SecurityCard {
  return {
    dependency: { id: `dep:npm:${name}@${version}`, ecosystem: 'npm', name, version },
    advisory: { id: advisory },
    fix: { fixedIn: null, ...(action ? { action } : {}) },
  } as unknown as SecurityCard
}

describe('security fix plan (classify)', () => {
  it('puts a same-major bump in fixable with its target and advisories', () => {
    const plan = classify([card('lodash', '4.17.15', { kind: 'bump-to-fixedIn', to: '4.17.21', via: [] })])
    expect(plan.fixable).toEqual([
      { dependency: { ecosystem: 'npm', name: 'lodash', version: '4.17.15' }, to: '4.17.21', advisories: ['GHSA-a'] },
    ])
    expect(plan.skipped).toEqual([])
  })

  it('surfaces the reconciled target for the #1635 overlapping-range case', () => {
    // An advisory whose overlapping ranges forced the reconcile up to 1.9.0 (the
    // lowest release the matcher clears; proven in security-card.test.ts). The plan
    // must show that target, not the loose 1.5.0.
    const plan = classify([card('acme', '1.2.0', { kind: 'bump-to-fixedIn', to: '1.9.0', via: [] })])
    expect(plan.fixable[0]!.to).toBe('1.9.0')
  })

  it('skips a breaking-only fix, naming its major target in the reason', () => {
    const plan = classify([
      card('left-pad', '1.0.0', { kind: 'remove-or-replace', reason: 'needs 2.0.0, a major-version bump', majorTo: '2.0.0' }),
    ])
    expect(plan.fixable).toEqual([])
    expect(plan.skipped).toEqual([
      { dependency: { ecosystem: 'npm', name: 'left-pad', version: '1.0.0' }, reason: 'needs 2.0.0, a breaking bump' },
    ])
  })

  it('skips a no-fixed-release dependency with the engine reason', () => {
    const plan = classify([card('swig', '1.4.2', { kind: 'remove-or-replace', reason: 'the advisories list no fixed release' })])
    expect(plan.skipped[0]!.reason).toBe('the advisories list no fixed release')
  })

  it('skips a card with no action', () => {
    const plan = classify([card('old', '1.0.0', null)])
    expect(plan.skipped[0]!.reason).toBe('no fix action on the card')
  })

  it('dedupes per dependency and unions its advisories', () => {
    const plan = classify([
      card('lodash', '4.17.15', { kind: 'bump-to-fixedIn', to: '4.17.21', via: [] }, 'GHSA-b'),
      card('lodash', '4.17.15', { kind: 'bump-to-fixedIn', to: '4.17.21', via: [] }, 'GHSA-a'),
    ])
    expect(plan.fixable).toHaveLength(1)
    expect(plan.fixable[0]!.advisories).toEqual(['GHSA-a', 'GHSA-b'])
  })

  it('renders a human plan', () => {
    const lines = humanPlan(
      [{ dependency: { ecosystem: 'npm', name: 'lodash', version: '4.17.15' }, to: '4.17.21', advisories: ['GHSA-a'] }],
      [{ dependency: { ecosystem: 'npm', name: 'swig', version: '1.4.2' }, reason: 'no fix' }],
    )
    expect(lines[0]).toBe('neat security fix: 1 fixable, 1 not auto-fixable.')
    expect(lines).toContain('Run with --apply to write the fixes.')
  })
})
