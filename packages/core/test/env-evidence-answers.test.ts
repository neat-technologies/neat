import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, Provenance, type ErrorEvent, type GraphEdge, type GraphNode, type Policy } from '@neat.is/types'
import { buildErrorEventForReceiver, handleSpan, resetParentSpanCache, type IngestContext } from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'
import type { NeatGraph } from '../src/graph.js'
import {
  getBlastRadius,
  getObservedDependencies,
  getRootCause,
  getTransitiveDependencies,
} from '../src/traverse.js'
import { computeDivergences } from '../src/divergences.js'
import { evaluateAllPolicies } from '../src/policy.js'
import { composeNodeCard, buildIncidentCard } from '../src/goodybag.js'

// ADR-280 slice one: runtime evidence carries its environment, and no query
// reads it yet. The proof that no answer changed: a fixed graph is built from
// the same spans and every query module is asked the same questions, and the
// answers are compared with the ones `main` gave before the slice (recorded in
// fixtures/env-evidence-answers.json by running this file on main with
// RECORD_ENV_EVIDENCE_ANSWERS=1).
//
// Two single-environment projects:
// - `unknown`: telemetry with no environment label, every unlabelled local
//   project. The answers are byte-identical.
// - `production`: telemetry labelled with one environment. The runtime edge ids
//   now name it (`OBSERVED@production`) and edges and incidents carry `env`, by
//   decision 2; with those two stripped the answers are byte-identical.

const FIXTURE = path.join(__dirname, 'fixtures', 'env-evidence-answers.json')
const NOW = Date.parse('2026-11-18T12:00:00.000Z')
const T = (s: number) => new Date(NOW - 60_000 + s * 1000).toISOString()

function baseGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  const svc = (name: string) =>
    g.addNode(`service:${name}`, { id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'javascript' } as GraphNode)
  svc('web')
  svc('orders')
  svc('billing')
  g.addNode('database:postgresql:orders-db', {
    id: 'database:postgresql:orders-db',
    type: NodeType.DatabaseNode,
    name: 'orders',
    engine: 'postgresql',
    engineVersion: '15',
    compatibleDrivers: [],
  } as GraphNode)
  const extracted = (source: string, target: string, type: string) => {
    const id = `${type}:${source}->${target}`
    g.addEdgeWithKey(id, source, target, { id, source, target, type, provenance: Provenance.EXTRACTED, confidence: 0.85 } as GraphEdge)
  }
  extracted('service:web', 'service:orders', EdgeType.CALLS)
  extracted('service:orders', 'database:postgresql:orders-db', EdgeType.CONNECTS_TO)
  extracted('service:orders', 'service:billing', EdgeType.CALLS)
  return g
}

function span(env: string, o: Partial<ParsedSpan>): ParsedSpan {
  return {
    service: 'web',
    traceId: 'trace-1',
    spanId: 's',
    name: 'op',
    kind: 3,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env,
    attributes: {},
    statusCode: 0,
    ...o,
  }
}

function spans(env: string): ParsedSpan[] {
  return [
    span(env, { spanId: 'a1', startTimeIso: T(1), durationNanos: 20_000_000n, attributes: { 'http.method': 'GET', 'server.address': 'orders', 'server.port': 3001 } }),
    span(env, { spanId: 'a2', startTimeIso: T(2), durationNanos: 30_000_000n, attributes: { 'http.method': 'GET', 'server.address': 'orders', 'server.port': 3001 } }),
    span(env, {
      service: 'orders',
      spanId: 'b1',
      parentSpanId: 'a1',
      startTimeIso: T(3),
      name: 'pg.query',
      attributes: { 'db.system': 'postgresql', 'db.name': 'orders', 'server.address': 'orders-db' },
      dbSystem: 'postgresql',
      dbName: 'orders',
    }),
    span(env, {
      service: 'orders',
      spanId: 'b2',
      parentSpanId: 'a2',
      startTimeIso: T(4),
      kind: 2,
      name: 'POST /checkout',
      statusCode: 2,
      attributes: { 'http.method': 'POST', 'http.route': '/checkout', 'http.response.status_code': 500 },
      exception: { type: 'TypeError', message: "Cannot read properties of undefined (reading 'map')" },
    }),
    span(env, { service: 'search', spanId: 'c1', startTimeIso: T(5), attributes: { 'http.method': 'GET', 'server.address': 'orders', 'server.port': 3001 } }),
  ]
}

const POLICIES: Policy[] = [
  {
    id: 'calls-into-billing-observed',
    name: 'calls into billing must be observed',
    severity: 'error',
    rule: { type: 'provenance', edgeType: EdgeType.CALLS, targetNodeId: 'service:billing', requiredProvenance: Provenance.OBSERVED },
  } as unknown as Policy,
]

async function answersFor(env: string): Promise<Record<string, unknown>> {
  resetParentSpanCache()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-env-answers-'))
  try {
    const ctx: IngestContext = { graph: baseGraph(), errorsPath: path.join(dir, 'errors.ndjson') }
    const incidents: ErrorEvent[] = []
    for (const s of spans(env)) {
      await handleSpan(ctx, s)
      const ev = buildErrorEventForReceiver(s, ctx.graph)
      if (ev) incidents.push(ev)
    }
    const g = ctx.graph
    const nodes: Record<string, unknown> = {}
    g.forEachNode((id, a) => (nodes[id] = a))
    const edges: Record<string, unknown> = {}
    g.forEachEdge((id, a) => (edges[id] = a))
    const origin = incidents[0]?.affectedNode ?? 'service:orders'
    return {
      nodes,
      edges,
      incidents,
      divergences: computeDivergences(g),
      rootCause: getRootCause(g, origin, incidents[0], incidents, { now: NOW }),
      blastRadius: getBlastRadius(g, 'database:postgresql:orders-db'),
      dependencies: getTransitiveDependencies(g, 'service:web'),
      observedDependencies: getObservedDependencies(g, 'service:web'),
      policyViolations: evaluateAllPolicies(g, POLICIES, { now: () => NOW }),
      nodeCard: composeNodeCard(g, 'service:orders', incidents, POLICIES),
      incidentCard: incidents[0] ? buildIncidentCard(g, incidents[0], incidents, POLICIES) : null,
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// Drop what decision 2 adds for a named environment: the `@<env>` segment of a
// runtime edge id and the `env` field on edges and incidents. Node-level `env`
// (an OTel-only service in a named environment) predates ADR-280 and is kept.
function withoutEvidenceEnv(value: unknown, env: string): unknown {
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
      // Only an edge (it has a provenance) or an incident (it has a traceId).
      if (key === 'env' && v === env && ('provenance' in this || 'traceId' in this)) return undefined
      return v
    })
      .split(`OBSERVED@${env}:`)
      .join('OBSERVED:')
      .split(`INFERRED@${env}:`)
      .join('INFERRED:'),
  )
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
}

describe('ADR-280 slice one: no query answer changes for a single-environment project', () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('records or compares the answers', async () => {
    const unknown = await answersFor('unknown')
    const production = await answersFor('production')
    if (process.env.RECORD_ENV_EVIDENCE_ANSWERS === '1') {
      await fs.mkdir(path.dirname(FIXTURE), { recursive: true })
      await fs.writeFile(FIXTURE, stable({ unknown, production }) + '\n')
      return
    }
    const before = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as { unknown: unknown; production: unknown }
    // With no environment label nothing at all differs.
    expect(stable(unknown)).toBe(stable(before.unknown))
    // With one named environment the answers are the same once the environment
    // decision 2 puts on the evidence is taken off again.
    expect(stable(withoutEvidenceEnv(production, 'production'))).toBe(stable(before.production))
    // And the evidence does carry it.
    const prodEdges = Object.values(production.edges as Record<string, GraphEdge>)
    expect(prodEdges.filter((e) => e.provenance === Provenance.OBSERVED).every((e) => e.env === 'production' && e.id.includes('OBSERVED@production:'))).toBe(true)
    expect((production.incidents as ErrorEvent[]).every((i) => i.env === 'production')).toBe(true)
    expect(Object.values(unknown.edges as Record<string, GraphEdge>).some((e) => 'env' in e)).toBe(false)
  })
})
