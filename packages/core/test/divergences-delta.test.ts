import { describe, it, expect } from 'vitest'
import { EdgeType, Provenance } from '@neat.is/types'
import type { Divergence } from '@neat.is/types'
import { divergenceIdentity, newDivergences } from '../src/divergences.js'

// ADR-277, the no-regression gate's "no new divergence" condition. The delta is keyed on
// divergence identity, so a divergence that only moved a line or whose evidence shifted is
// not reported as new; a genuinely different finding is.

const common = { confidence: 0.9, reason: 'r', recommendation: 'rec' }

const missingObserved = (source: string, target: string, over: Partial<Divergence> = {}): Divergence =>
  ({ type: 'missing-observed', source, target, edgeType: EdgeType.CALLS, ...common, ...over }) as Divergence

const symbolMismatch = (source: string, over: Partial<Divergence> = {}): Divergence =>
  ({
    type: 'observed-symbol-mismatch',
    source,
    target: source,
    mismatchKind: 'missing-attribute',
    provenance: Provenance.INFERRED,
    errorMessage: 'boom',
    ...common,
    ...over,
  }) as Divergence

const versionMismatch = (source: string, target: string, over: Partial<Divergence> = {}): Divergence =>
  ({
    type: 'version-mismatch',
    source,
    target,
    extractedVersion: '1.0.0',
    observedVersion: '2.0.0',
    compatibility: 'incompatible',
    ...common,
    ...over,
  }) as Divergence

const configMismatch = (source: string, field: string, over: Partial<Divergence> = {}): Divergence =>
  ({
    type: 'config-mismatch',
    source,
    target: source,
    kind: 'address-port',
    field,
    evidence: [
      { role: 'caller address', value: 'a:1', location: 'x:1', provenance: Provenance.EXTRACTED },
      { role: 'service port', value: '2', location: 'Service s', provenance: Provenance.OBSERVED },
    ],
    ...common,
    ...over,
  }) as Divergence

describe('newDivergences — base-versus-head delta (ADR-277)', () => {
  it('reports a finding present in head but not base', () => {
    const base = [missingObserved('service:a', 'service:b')]
    const head = [missingObserved('service:a', 'service:b'), missingObserved('service:a', 'service:c')]
    const out = newDivergences(base, head)
    expect(out.map((d) => d.target)).toEqual(['service:c'])
  })

  it('an empty base makes every head finding new; an empty head makes none', () => {
    const head = [missingObserved('service:a', 'service:b'), versionMismatch('service:a', 'pkg:x')]
    expect(newDivergences([], head)).toHaveLength(2)
    expect(newDivergences(head, [])).toHaveLength(0)
  })

  it('does not report a divergence that only moved a line', () => {
    // Same identity, different declaring location: a symbol mismatch whose code moved.
    const base = [symbolMismatch('file:api.ts', { symbol: 'user', location: 'file:api.ts:10' })]
    const head = [symbolMismatch('file:api.ts', { symbol: 'user', location: 'file:api.ts:42' })]
    expect(newDivergences(base, head)).toHaveLength(0)
  })

  it('does not report a divergence whose evidence shifted but identity held', () => {
    // Same missing-observed edge, different confidence and extracted-edge detail.
    const base = [missingObserved('service:a', 'service:b', { confidence: 0.9 })]
    const head = [missingObserved('service:a', 'service:b', { confidence: 0.6 })]
    expect(newDivergences(base, head)).toHaveLength(0)
    // Same version-mismatch edge, bumped versions: still the same divergence, not new.
    const vBase = [versionMismatch('service:a', 'pkg:x', { observedVersion: '2.0.0' })]
    const vHead = [versionMismatch('service:a', 'pkg:x', { observedVersion: '3.0.0' })]
    expect(newDivergences(vBase, vHead)).toHaveLength(0)
  })

  it('reports a finding whose semantic discriminator changed', () => {
    // Same node pair, different accessed member: a different symbol mismatch.
    const base = [symbolMismatch('file:api.ts', { symbol: 'user', location: 'file:api.ts:10' })]
    const head = [symbolMismatch('file:api.ts', { symbol: 'account', location: 'file:api.ts:10' })]
    expect(newDivergences(base, head).map((d) => (d as { symbol?: string }).symbol)).toEqual(['account'])
    // Same node, different config field.
    const cBase = [configMismatch('service:a', 'port')]
    const cHead = [configMismatch('service:a', 'port'), configMismatch('service:a', 'selector')]
    expect(newDivergences(cBase, cHead).map((d) => (d as { field?: string }).field)).toEqual(['selector'])
  })

  it('a resolved divergence (in base, gone from head) is not reported', () => {
    const base = [missingObserved('service:a', 'service:b'), missingObserved('service:a', 'service:c')]
    const head = [missingObserved('service:a', 'service:b')]
    expect(newDivergences(base, head)).toHaveLength(0)
  })
})

describe('divergenceIdentity', () => {
  it('ignores location, confidence and values; keys on type, nodes and semantic locus', () => {
    expect(divergenceIdentity(symbolMismatch('file:a', { symbol: 's', location: 'file:a:1', confidence: 0.6 }))).toBe(
      divergenceIdentity(symbolMismatch('file:a', { symbol: 's', location: 'file:a:999', confidence: 0.9 })),
    )
  })

  it('separates findings that differ by type, node pair, or discriminator', () => {
    const a = divergenceIdentity(missingObserved('service:a', 'service:b', { edgeType: EdgeType.CALLS }))
    const b = divergenceIdentity(missingObserved('service:a', 'service:b', { edgeType: EdgeType.CONNECTS_TO }))
    expect(a).not.toBe(b)
    expect(divergenceIdentity(versionMismatch('service:a', 'pkg:x'))).not.toBe(
      divergenceIdentity(versionMismatch('service:a', 'pkg:y')),
    )
  })
})
