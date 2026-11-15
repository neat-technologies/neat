import { describe, it, expect } from 'vitest'
import { EdgeType, Provenance, serviceId } from '@neat.is/types'
import type { Divergence, SecurityDiff, SecurityDiffEntry } from '@neat.is/types'
import { buildGateVerdict, type GateVerdictInput } from '../src/pr-verdict.js'

// ADR-277: the four tri-state conditions + the parallel Sniper-targetable findings. Fail-closed:
// an unevaluable condition is unknown and `passed` is true only when all four pass. observed-break
// findings ride the list but never affect a condition or `passed`.

const common = { confidence: 0.9, reason: 'r', recommendation: 'rec' }

const configMismatch = (source: string, field = 'port'): Divergence =>
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
  }) as Divergence

const missingObserved = (source: string, target: string): Divergence =>
  ({ type: 'missing-observed', source, target, edgeType: EdgeType.CALLS, ...common }) as Divergence

const sdiff = (over: Partial<SecurityDiff> = {}): SecurityDiff =>
  ({
    advisories: 'mirror',
    asOf: '2026-11-15T00:00:00Z',
    stale: 0,
    errors: [],
    base: { ref: 'b', inventory: 0 },
    head: { ref: 'h', inventory: 0 },
    introduced: [],
    removed: [],
    stillPresent: [],
    context: { introduced: [], removed: [] },
    ...over,
  }) as SecurityDiff

const vulnEntry = (advisoryId: string, pkg: string): SecurityDiffEntry =>
  ({
    advisoryId,
    ecosystem: 'npm',
    package: pkg,
    service: 'api',
    before: null,
    after: {
      kind: 'security',
      id: 'card',
      service: 'api',
      advisory: { id: advisoryId },
      dependency: { version: '1.2.3' },
      fix: { fixedIn: ['1.2.4'] },
      reachability: { importers: [{ file: 'src/app.ts', line: 7, provenance: 'EXTRACTED' }], observed: [] },
    },
  }) as unknown as SecurityDiffEntry

const input = (over: Partial<GateVerdictInput> = {}): GateVerdictInput => ({
  introducedDivergences: [],
  securityDiff: sdiff(),
  observedBreaks: [],
  affectedFiles: 1,
  affectedServices: 1,
  gate: { tests: 'pass' },
  ...over,
})

describe('buildGateVerdict (ADR-277)', () => {
  it('all four conditions pass, no findings => passed', () => {
    const v = buildGateVerdict(input())
    expect(v.conditions.map((c) => c.name)).toEqual(['blast-radius', 'tests', 'no-new-divergence', 'security'])
    expect(v.conditions.every((c) => c.status === 'pass')).toBe(true)
    expect(v.findings).toHaveLength(0)
    expect(v.passed).toBe(true)
  })

  it('an absent test outcome is unknown and fails closed', () => {
    const v = buildGateVerdict(input({ gate: {} }))
    expect(v.conditions.find((c) => c.name === 'tests')!.status).toBe('unknown')
    expect(v.passed).toBe(false)
  })

  it('a counted divergence fails no-new-divergence and emits a divergence finding', () => {
    const v = buildGateVerdict(input({ introducedDivergences: [configMismatch('service:a')] }))
    expect(v.conditions.find((c) => c.name === 'no-new-divergence')!.status).toBe('fail')
    expect(v.findings.filter((f) => f.kind === 'divergence')).toHaveLength(1)
    expect(v.passed).toBe(false)
  })

  it('missing-observed does not count (a new edge has had no chance to be observed)', () => {
    const v = buildGateVerdict(input({ introducedDivergences: [missingObserved('service:a', 'service:b')] }))
    expect(v.conditions.find((c) => c.name === 'no-new-divergence')!.status).toBe('pass')
    expect(v.findings.filter((f) => f.kind === 'divergence')).toHaveLength(0)
  })

  it('security is unknown when advisories are off or the scan did not run, never pass', () => {
    const off = buildGateVerdict(input({ securityDiff: sdiff({ asOf: null, advisories: 'disabled' }) }))
    const sec = off.conditions.find((c) => c.name === 'security')!
    expect(sec.status).toBe('unknown')
    expect(sec.detail).toMatch(/disabled/)
    expect(off.passed).toBe(false)
    expect(buildGateVerdict(input({ securityDiff: null })).conditions.find((c) => c.name === 'security')!.status).toBe(
      'unknown',
    )
  })

  it('an introduced vulnerability fails security and emits a vulnerability finding', () => {
    const v = buildGateVerdict(input({ securityDiff: sdiff({ introduced: [vulnEntry('GHSA-xxxx', 'left-pad')] }) }))
    expect(v.conditions.find((c) => c.name === 'security')!.status).toBe('fail')
    const f = v.findings.find((fi) => fi.kind === 'vulnerability')!
    expect(f.advisoryId).toBe('GHSA-xxxx')
    expect(f.fixedIn).toBe('1.2.4')
    expect(f.locus).toEqual({ file: 'src/app.ts', line: 7 })
    expect(f.affectedNode).toBe(serviceId('api'))
    expect(f.provenance).toBe(Provenance.EXTRACTED)
    expect(f.findingId).toMatch(/^[0-9a-f]{64}$/)
    expect(v.passed).toBe(false)
  })

  it('blast radius over the ceiling fails', () => {
    const v = buildGateVerdict(input({ affectedFiles: 999 }))
    expect(v.conditions.find((c) => c.name === 'blast-radius')!.status).toBe('fail')
    expect(v.passed).toBe(false)
  })

  it('an observed break is a finding but never affects passed', () => {
    const v = buildGateVerdict(input({ observedBreaks: [{ id: 'service:x' }] }))
    const f = v.findings.find((fi) => fi.kind === 'observed-break')!
    expect(f.affectedNode).toBe('service:x')
    expect(f.locus).toBeNull()
    expect(f.provenance).toBe(Provenance.OBSERVED)
    expect(v.passed).toBe(true)
  })

  it('findingId is a deterministic 64-char lowercase hex digest', () => {
    const a = buildGateVerdict(input({ introducedDivergences: [configMismatch('service:a')] })).findings[0]!
    const b = buildGateVerdict(input({ introducedDivergences: [configMismatch('service:a')] })).findings[0]!
    expect(a.findingId).toBe(b.findingId)
    expect(a.findingId).toMatch(/^[0-9a-f]{64}$/)
  })
})
