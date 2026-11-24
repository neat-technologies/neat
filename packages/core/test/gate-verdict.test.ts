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

const vulnEntry = (advisoryId: string, pkg: string, card: Record<string, unknown> = {}): SecurityDiffEntry =>
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
      dependency: { version: '1.2.3', manifest: { file: 'package.json' } },
      fix: { fixedIn: ['1.2.4'] },
      reachability: { level: 'imported', importers: [{ file: 'src/app.ts', line: 7, provenance: 'EXTRACTED' }], observed: [], supporting: [] },
      ...card,
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
    expect(f.provenance).toBe(Provenance.EXTRACTED)
    expect(f.findingId).toMatch(/^[0-9a-f]{64}$/)
    expect(v.passed).toBe(false)
  })

  // Where a vulnerability finding points depends on how it is fixed (#1751, ruled 2026-11-21).
  describe('a vulnerability finding points at code by fix type', () => {
    const finding = (card: Record<string, unknown>) =>
      buildGateVerdict(input({ securityDiff: sdiff({ introduced: [vulnEntry('GHSA-xxxx', 'left-pad', card)] }) })).findings.find(
        (fi) => fi.kind === 'vulnerability',
      )!
    const bump = { fix: { fixedIn: ['1.2.4'], action: { kind: 'bump-to-fixedIn', to: '1.2.4', via: [] } } }
    const replace = { fix: { fixedIn: null, action: { kind: 'remove-or-replace', reason: 'no fixed release' } } }

    it('a bump points at the manifest, on the importing service', () => {
      const f = finding({ ...bump, dependency: { version: '1.2.3', manifest: { file: '/package-lock.json', line: 12 } } })
      expect(f.affectedNode).toBe(serviceId('api'))
      expect(f.locus).toEqual({ file: 'package-lock.json', line: 12 })
    })

    it('a bump with no recorded manifest file has no locus', () => {
      const f = finding({ ...bump, dependency: { version: '1.2.3', manifest: { file: '' } } })
      expect(f.affectedNode).toBe(serviceId('api'))
      expect(f.locus).toBeNull()
    })

    it('a remove-or-replace on a reachable-static card points at the head of the call path', () => {
      const caller = 'symbol:api:src/routes/orders.ts#OrderRoute.handle'
      const f = finding({
        ...replace,
        reachability: {
          level: 'reachable-static',
          importers: [{ file: 'src/app.ts', line: 7, provenance: 'EXTRACTED' }],
          path: [{ from: caller, to: 'symbol:dep:npm:left-pad@1.2.3:index.js#leftPad', provenance: 'EXTRACTED' }],
          observed: [],
          supporting: [],
        },
      })
      expect(f.affectedNode).toBe(caller)
      expect(f.locus).toEqual({ file: 'src/routes/orders.ts', symbol: 'OrderRoute.handle' })
    })

    it('a call path that starts at a file points at the file', () => {
      const f = finding({
        ...replace,
        reachability: {
          level: 'reachable-static',
          importers: [],
          path: [{ from: 'file:api:src/boot.ts', to: 'symbol:dep:npm:left-pad@1.2.3:index.js#leftPad', provenance: 'EXTRACTED' }],
          observed: [],
          supporting: [],
        },
      })
      expect(f.affectedNode).toBe('file:api:src/boot.ts')
      expect(f.locus).toEqual({ file: 'src/boot.ts' })
    })

    it('a remove-or-replace on a reachable-observed card points at the importer seen running', () => {
      const runner = 'symbol:api:src/jobs/sync.ts#syncAll'
      const f = finding({
        ...replace,
        reachability: {
          level: 'reachable-observed',
          importers: [{ file: 'src/app.ts', line: 7, provenance: 'EXTRACTED' }],
          observed: [{ source: 'instrumentation-scope', at: '2026-11-21T00:00:00Z', provenance: 'OBSERVED' }],
          supporting: [{ kind: 'importer-observed', symbol: runner, at: '2026-11-21T00:00:00Z' }],
        },
      })
      expect(f.affectedNode).toBe(runner)
      expect(f.locus).toEqual({ file: 'src/jobs/sync.ts', symbol: 'syncAll' })
      expect(f.provenance).toBe(Provenance.OBSERVED)
    })

    it('a remove-or-replace with no first-party caller points at the service with no locus', () => {
      // Imported only: an importer is not a caller, so nothing is named.
      const f = finding(replace)
      expect(f.affectedNode).toBe(serviceId('api'))
      expect(f.locus).toBeNull()
    })

    it('the finding id does not depend on where it points', () => {
      const a = finding(bump).findingId
      const b = finding({
        ...replace,
        reachability: {
          level: 'reachable-static',
          importers: [],
          path: [{ from: 'symbol:api:src/a.ts#f', to: 'symbol:dep:npm:left-pad@1.2.3:index.js#leftPad', provenance: 'EXTRACTED' }],
          observed: [],
          supporting: [],
        },
      }).findingId
      expect(a).toBe(b)
    })
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
