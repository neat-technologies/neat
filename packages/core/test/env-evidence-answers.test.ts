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
import { environmentFor } from '../src/runtime-env.js'
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

// One project, the given environments each sending the same spans (their trace
// and span ids kept apart). `ask` is the environment a read names; omitted, the
// read resolves it (ADR-280 decision 4) and policies cover the resolved one.
async function answersFor(env: string | string[], ask?: string): Promise<Record<string, unknown>> {
  const envs = Array.isArray(env) ? env : [env]
  resetParentSpanCache()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-env-answers-'))
  try {
    const ctx: IngestContext = { graph: baseGraph(), errorsPath: path.join(dir, 'errors.ndjson') }
    const incidents: ErrorEvent[] = []
    const all = envs.flatMap((e, i) =>
      spans(e).map((x) =>
        envs.length === 1
          ? x
          : { ...x, traceId: `${x.traceId}-${i}`, spanId: `${x.spanId}-${i}`, ...(x.parentSpanId ? { parentSpanId: `${x.parentSpanId}-${i}` } : {}) },
      ),
    )
    for (const s of all) {
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
      observedDependencies: getObservedDependencies(g, 'service:web', ask === undefined ? {} : { env: ask }),
      policyViolations: evaluateAllPolicies(g, POLICIES, { now: () => NOW }, { env: environmentFor(g, ask === undefined ? {} : { env: ask }) }),
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
      // An edge (it has a provenance), an incident (a traceId), a policy violation
      // (a policyId) or an answer that states its environment (decisions 3, 7).
      if (key === 'env' && v === env && ('provenance' in this || 'traceId' in this || 'policyId' in this || 'origin' in this)) return undefined
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

// A project with two environments sending the same traffic. Each environment's
// runtime evidence is its own: asked for one environment, every answer that
// reads runtime evidence equals the single-environment answer for it, and the
// default (no environment named) is the production one. No answer lists one
// fact twice.
describe('ADR-280: two environments, each answered on its own', () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  const runtimeReads = ['observedDependencies', 'policyViolations'] as const
  // The `@<env>` in an id and the `env` on edges, incidents, violations and answers,
  // renamed to one environment, so production's answer and staging's compare.
  const asEnv = (value: unknown, from: string, to: string) =>
    JSON.parse(JSON.stringify(value).split(`@${from}:`).join(`@${to}:`).split(`"env":"${from}"`).join(`"env":"${to}"`))

  it('answers for production by default, and for staging when asked, each as if it were alone', async () => {
    const both = await answersFor(['production', 'staging'])
    const bothStaging = await answersFor(['production', 'staging'], 'staging')
    const prodAlone = await answersFor('production')
    const stagingAlone = await answersFor('staging')
    for (const read of runtimeReads) {
      expect(stable(both[read])).toBe(stable(prodAlone[read]))
      expect(stable(bothStaging[read])).toBe(stable(stagingAlone[read]))
      expect(stable(asEnv(bothStaging[read], 'staging', 'production'))).toBe(stable(prodAlone[read]))
    }
  })

  it('lists no fact twice', async () => {
    const both = await answersFor(['production', 'staging'])
    const deps = (both.observedDependencies as { dependencies: GraphEdge[] }).dependencies
    expect(new Set(deps.map((e) => `${e.type} ${e.source}->${e.target}`)).size).toBe(deps.length)
    const violations = both.policyViolations as Array<{ id: string; subject: { edgeId?: string; nodeId?: string } }>
    expect(new Set(violations.map((v) => v.id)).size).toBe(violations.length)
    expect(violations.every((v) => !(v.subject.edgeId ?? '').includes('@staging:'))).toBe(true)
  })

  it('records every environment in the ledger form, each naming its environment, with no id shared', async () => {
    resetParentSpanCache()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-env-ledger-'))
    try {
      const ctx: IngestContext = { graph: baseGraph(), errorsPath: path.join(dir, 'errors.ndjson') }
      for (const [i, e] of ['production', 'staging'].entries()) {
        for (const s of spans(e)) await handleSpan(ctx, { ...s, traceId: `${s.traceId}-${i}`, spanId: `${s.spanId}-${i}`, ...(s.parentSpanId ? { parentSpanId: `${s.parentSpanId}-${i}` } : {}) })
      }
      const all = evaluateAllPolicies(ctx.graph, POLICIES, { now: () => NOW })
      expect(new Set(all.map((v) => v.id)).size).toBe(all.length)
      // The static violation (the EXTRACTED edge into billing) once, with no environment.
      expect(all.filter((v) => v.env === undefined).map((v) => v.subject.edgeId)).toEqual(['CALLS:service:orders->service:billing'])
      // The INFERRED edge's violation once per environment, each naming it.
      expect(all.filter((v) => v.env !== undefined).map((v) => v.env).sort()).toEqual(['production', 'staging'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a read that names no environment when none of several is production', async () => {
    await expect(answersFor(['staging', 'qa'])).rejects.toMatchObject({ code: 'environment_required', environments: ['qa', 'staging'] })
  })
})

