import { describe, it, expect } from 'vitest'
import type {
  Divergence,
  DivergenceResult,
  GraphEdge,
  PoliciesViolationsResponse,
  PolicyViolation,
} from '@neat.is/types'
import { observedEdgeId } from '@neat.is/types'
import {
  divergenceKey,
  formatDivergenceLine,
  formatStaleLine,
  formatObservedEdgeLine,
  formatPolicyLine,
  policyKey,
  MonitorEmitter,
} from '../src/monitor.js'

// The monitor (ADR-159) must map real graph facts to one greppable line each,
// print each fact exactly once, and stay silent when nothing is new. These
// tests drive the pure mapping + the seen-set directly — no network, no daemon.

function divResult(divergences: Divergence[]): DivergenceResult {
  return {
    divergences,
    totalAffected: divergences.length,
    computedAt: '2026-08-02T00:00:00.000Z',
  }
}

// A missing-observed edge-locus divergence: code declares an edge production
// never ran.
const missingObserved: Divergence = {
  type: 'missing-observed',
  source: 'service:checkout',
  target: 'database:pg',
  edgeType: 'CONNECTS_TO',
  confidence: 0.82,
  reason: 'declared, never observed',
  recommendation: 'check feature flags',
}

// A missing-extracted column-locus divergence: production wrote a column the
// schema never declared.
const missingExtractedColumn: Divergence = {
  type: 'missing-extracted',
  source: 'sql-table:orders',
  target: 'sql-table:orders',
  table: 'orders',
  column: 'amount',
  confidence: 0.9,
  reason: 'production touched orders.amount',
  recommendation: 'the schema is behind the code',
}

// A missing-observed column-locus divergence: the schema declares a column
// production never touched.
const missingObservedColumn: Divergence = {
  type: 'missing-observed',
  source: 'sql-table:orders',
  target: 'sql-table:orders',
  table: 'orders',
  column: 'total',
  confidence: 0.88,
  reason: 'declared, never observed',
  recommendation: 'a rename may have left this column dead',
}

describe('monitor: divergence → line', () => {
  it('renders a missing-observed edge divergence', () => {
    expect(formatDivergenceLine(missingObserved)).toBe(
      '⚠ divergence [missing-observed] service:checkout → database:pg declared, never observed in production',
    )
  })

  it('renders a missing-extracted column divergence at column grain', () => {
    expect(formatDivergenceLine(missingExtractedColumn)).toBe(
      '⚠ divergence [missing-extracted] production writes orders.amount — not declared in code',
    )
  })

  it('renders a missing-observed column divergence at column grain', () => {
    expect(formatDivergenceLine(missingObservedColumn)).toBe(
      '⚠ divergence [missing-observed] orders.total declared, never observed in production',
    )
  })

  it('renders a version-mismatch divergence', () => {
    const d: Divergence = {
      type: 'version-mismatch',
      source: 'service:api',
      target: 'database:pg',
      extractedVersion: 'pg@7.4.0',
      observedVersion: '15',
      compatibility: 'incompatible',
      confidence: 1,
      reason: 'incompatible',
      recommendation: 'upgrade',
    }
    expect(formatDivergenceLine(d)).toBe(
      '⚠ divergence [version-mismatch] service:api → database:pg declared pg@7.4.0, observed 15 (incompatible)',
    )
  })

  it('gives each divergence a stable, distinct dedup key', () => {
    expect(divergenceKey(missingObserved)).toBe(divergenceKey({ ...missingObserved }))
    expect(divergenceKey(missingObserved)).not.toBe(divergenceKey(missingExtractedColumn))
  })
})

describe('monitor: stale-transition → line', () => {
  it('parses the OBSERVED edge id back to source → target', () => {
    const id = observedEdgeId('service:checkout', 'database:pg', 'CONNECTS_TO')
    expect(formatStaleLine(id)).toBe(
      '⋯ stale  service:checkout → database:pg  (observed edge went quiet)',
    )
  })

  it('falls back to the raw id when it is not a well-formed edge id', () => {
    expect(formatStaleLine('not-an-edge-id')).toBe(
      '⋯ stale  not-an-edge-id  (observed edge went quiet)',
    )
  })
})

function observedEdge(over: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: observedEdgeId('service:checkout', 'frontier:stripe', 'CALLS'),
    source: 'service:checkout',
    target: 'frontier:stripe',
    type: 'CALLS',
    provenance: 'OBSERVED',
    ...over,
  } as GraphEdge
}

describe('monitor: OBSERVED edge → line', () => {
  it('renders a new observed runtime dependency', () => {
    expect(formatObservedEdgeLine(observedEdge())).toBe(
      '+ observed  service:checkout → frontier:stripe  (new runtime dependency)',
    )
  })
})

// A recorded soft-guardrail violation (ADR-108 / ADR-043). The id is
// deterministic — the monitor keys its seen-set off it.
const dbBoundaryViolation: PolicyViolation = {
  id: 'no-web-to-db:service:web',
  policyId: 'no-web-to-db',
  policyName: 'web tier must not touch the database directly',
  severity: 'error',
  onViolation: 'alert',
  ruleType: 'structural',
  subject: { nodeId: 'service:web' },
  message: 'service:web connects straight to database:pg',
  observedAt: '2026-08-02T00:00:00.000Z',
}

function policyResponse(violations: PolicyViolation[]): PoliciesViolationsResponse {
  return { violations }
}

describe('monitor: policy violation → line', () => {
  it('renders a violation with severity, name, message, and subject', () => {
    expect(formatPolicyLine(dbBoundaryViolation)).toBe(
      '⚠ policy [error] web tier must not touch the database directly — ' +
        'service:web connects straight to database:pg  (service:web)',
    )
  })

  it('falls back to edge / path when there is no subject node', () => {
    const edgeSubject: PolicyViolation = {
      ...dbBoundaryViolation,
      id: 'no-web-to-db:edge',
      subject: { edgeId: 'CONNECTS_TO:service:web->database:pg' },
    }
    expect(formatPolicyLine(edgeSubject)).toContain('(CONNECTS_TO:service:web->database:pg)')
    const pathSubject: PolicyViolation = {
      ...dbBoundaryViolation,
      id: 'no-web-to-db:path',
      subject: { path: ['service:web', 'database:pg'] },
    }
    expect(formatPolicyLine(pathSubject)).toContain('(service:web → database:pg)')
  })

  it('gives each violation a stable, distinct dedup key', () => {
    expect(policyKey(dbBoundaryViolation)).toBe(policyKey({ ...dbBoundaryViolation }))
    expect(policyKey(dbBoundaryViolation)).not.toBe(
      policyKey({ ...dbBoundaryViolation, id: 'other:service:web' }),
    )
  })
})

describe('MonitorEmitter seen-set (each fact once)', () => {
  function makeEmitter(json = false): { emitter: MonitorEmitter; lines: string[] } {
    const lines: string[] = []
    const emitter = new MonitorEmitter({ json, write: (l) => lines.push(l) })
    return { emitter, lines }
  }

  it('prints a divergence once and stays silent on a repeat read', () => {
    const { emitter, lines } = makeEmitter()
    const first = emitter.emitDivergences(divResult([missingObserved]))
    expect(first).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('⚠ divergence [missing-observed]')

    // Same divergence re-read (an unrelated trigger fired) → nothing new.
    const second = emitter.emitDivergences(divResult([missingObserved]))
    expect(second).toBe(0)
    expect(lines).toHaveLength(1)
  })

  it('prints only the newly appeared divergence on a later read', () => {
    const { emitter, lines } = makeEmitter()
    emitter.emitDivergences(divResult([missingObserved]))
    expect(lines).toHaveLength(1)
    // A second divergence now exists; the first is already seen.
    emitter.emitDivergences(divResult([missingObserved, missingExtractedColumn]))
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('production writes orders.amount')
  })

  it('prints a stale transition once, keyed on the edge id', () => {
    const { emitter, lines } = makeEmitter()
    const id = observedEdgeId('service:checkout', 'database:pg', 'CONNECTS_TO')
    expect(emitter.emitStale(id)).toBe(true)
    expect(emitter.emitStale(id)).toBe(false)
    expect(lines).toHaveLength(1)
  })

  it('emits an OBSERVED dependency edge once and ignores non-dependency / non-OBSERVED edges', () => {
    const { emitter, lines } = makeEmitter()
    // A CALLS OBSERVED edge is a runtime dependency → emitted once.
    expect(emitter.emitObservedEdge(observedEdge())).toBe(true)
    expect(emitter.emitObservedEdge(observedEdge())).toBe(false)
    // A structural OBSERVED CONTAINS edge is ownership, not a dependency → skipped.
    expect(
      emitter.emitObservedEdge(
        observedEdge({
          id: observedEdgeId('service:checkout', 'file:src/x.ts', 'CONTAINS'),
          target: 'file:src/x.ts',
          type: 'CONTAINS',
        }),
      ),
    ).toBe(false)
    // An EXTRACTED edge is not a runtime observation → skipped.
    expect(emitter.emitObservedEdge(observedEdge({ provenance: 'EXTRACTED' }))).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('+ observed')
  })

  it('prints a policy violation once and stays silent on a repeat read', () => {
    const { emitter, lines } = makeEmitter()
    const first = emitter.emitPolicies(policyResponse([dbBoundaryViolation]))
    expect(first).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('⚠ policy [error]')

    // Same violation still recorded on a re-read (a later trigger fired) → nothing new.
    const second = emitter.emitPolicies(policyResponse([dbBoundaryViolation]))
    expect(second).toBe(0)
    expect(lines).toHaveLength(1)
  })

  it('prints only the newly appeared violation on a later read', () => {
    const { emitter, lines } = makeEmitter()
    emitter.emitPolicies(policyResponse([dbBoundaryViolation]))
    expect(lines).toHaveLength(1)
    const second: PolicyViolation = {
      ...dbBoundaryViolation,
      id: 'no-secret-log:file:src/log.ts',
      policyName: 'no secrets in logs',
      message: 'file:src/log.ts logs a credential',
      subject: { nodeId: 'file:src/log.ts' },
    }
    emitter.emitPolicies(policyResponse([dbBoundaryViolation, second]))
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('no secrets in logs')
  })

  it('emits one JSON object per line under --json', () => {
    const { emitter, lines } = makeEmitter(true)
    emitter.emitDivergences(divResult([missingObserved]))
    emitter.emitStale(observedEdgeId('service:checkout', 'database:pg', 'CONNECTS_TO'))
    emitter.emitObservedEdge(observedEdge())
    emitter.emitPolicies(policyResponse([dbBoundaryViolation]))
    expect(lines).toHaveLength(4)
    const div = JSON.parse(lines[0])
    expect(div.kind).toBe('divergence')
    expect(div.type).toBe('missing-observed')
    const stale = JSON.parse(lines[1])
    expect(stale.kind).toBe('stale')
    expect(stale.source).toBe('service:checkout')
    const edge = JSON.parse(lines[2])
    expect(edge.kind).toBe('observed')
    expect(edge.provenance).toBe('OBSERVED')
    const policy = JSON.parse(lines[3])
    expect(policy.kind).toBe('policy')
    expect(policy.id).toBe('no-web-to-db:service:web')
    expect(policy.severity).toBe('error')
  })
})
