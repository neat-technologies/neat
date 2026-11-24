import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  normalizeEnv,
  observedEdgeId,
  inferredEdgeId,
  parseEdgeId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import {
  buildErrorEventForReceiver,
  ensureServiceNode,
  handleSpan,
  resetParentSpanCache,
  type IngestContext,
} from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'
import type { NeatGraph } from '../src/graph.js'
import { migrateSnapshot, SCHEMA_VERSION, type PersistedGraph } from '../src/persist.js'

// ADR-280 slice one: environment is a dimension of runtime evidence. A code node
// is one node whatever environments run it; OBSERVED and INFERRED edges and
// incidents carry the environment, and a runtime edge id includes it.

function graph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const name of ['orders', 'billing']) {
    g.addNode(`service:${name}`, { id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'javascript' } as GraphNode)
  }
  return g
}

function call(env: string, o: Partial<ParsedSpan> = {}): ParsedSpan {
  return {
    service: 'orders',
    traceId: 't',
    spanId: `s-${env}-${Math.random()}`,
    name: 'GET /charge',
    kind: 3,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env,
    attributes: { 'http.method': 'GET', 'server.address': 'billing', 'server.port': 3001 },
    statusCode: 0,
    ...o,
  }
}

describe('normalizeEnv (ADR-280 decision 9)', () => {
  it('trims and lower-cases, and nothing else', () => {
    expect(normalizeEnv('  Production ')).toBe('production')
    expect(normalizeEnv('Prod')).toBe('prod')
    expect(normalizeEnv('prod')).not.toBe(normalizeEnv('production'))
    expect(normalizeEnv('us-east-1.staging_2')).toBe('us-east-1.staging_2')
  })
  it('reads an empty value, or one with a character an id cannot carry, as unknown', () => {
    for (const v of ['', '   ', 'a b', 'prod:1', 'x@y', 'a->b', '-lead', 'x'.repeat(65), undefined, null]) {
      expect(normalizeEnv(v as string)).toBe('unknown')
    }
  })
})

describe('runtime edge ids carry the environment (ADR-280 decision 2)', () => {
  it('names a named environment and keeps the env-less form for unknown', () => {
    expect(observedEdgeId('a', 'b', 'CALLS')).toBe('CALLS:OBSERVED:a->b')
    expect(observedEdgeId('a', 'b', 'CALLS', 'unknown')).toBe('CALLS:OBSERVED:a->b')
    expect(observedEdgeId('a', 'b', 'CALLS', ' Staging')).toBe('CALLS:OBSERVED@staging:a->b')
    expect(inferredEdgeId('a', 'b', 'CALLS', 'prod')).toBe('CALLS:INFERRED@prod:a->b')
    expect(parseEdgeId('CALLS:OBSERVED@staging:file:svc:a.js->service:b')).toEqual({
      type: 'CALLS',
      provenance: 'OBSERVED',
      source: 'file:svc:a.js',
      target: 'service:b',
      env: 'staging',
    })
    // A segment that is not a normalised environment is not an edge id.
    expect(parseEdgeId('CALLS:OBSERVED@Staging:a->b')).toBeNull()
    expect(parseEdgeId('CALLS:OBSERVED@unknown:a->b')).toBeNull()
  })
})

describe('ingest keeps one code node and puts the environment on the evidence', () => {
  let dir: string
  let ctx: IngestContext
  beforeEach(async () => {
    resetParentSpanCache()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-env-evidence-'))
    ctx = { graph: graph(), errorsPath: path.join(dir, 'errors.ndjson') }
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('splits one hop into an edge per environment on the same nodes', async () => {
    await handleSpan(ctx, call('production'))
    await handleSpan(ctx, call('production'))
    await handleSpan(ctx, call('staging', { statusCode: 2 }))
    const g = ctx.graph
    const services = g.filterNodes((_id, a) => a.type === NodeType.ServiceNode)
    expect(services.sort()).toEqual(['service:billing', 'service:orders'])
    const prod = g.getEdgeAttributes('CALLS:OBSERVED@production:service:orders->service:billing') as GraphEdge
    const stg = g.getEdgeAttributes('CALLS:OBSERVED@staging:service:orders->service:billing') as GraphEdge
    expect([prod.env, prod.signal?.spanCount, prod.signal?.errorCount]).toEqual(['production', 2, 0])
    expect([stg.env, stg.signal?.spanCount, stg.signal?.errorCount]).toEqual(['staging', 1, 1])
    expect(g.hasEdge('CALLS:OBSERVED:service:orders->service:billing')).toBe(false)
  })

  it('leaves an unlabelled observation as it always was: no env field, the env-less id', async () => {
    await handleSpan(ctx, call('unknown'))
    const e = ctx.graph.getEdgeAttributes('CALLS:OBSERVED:service:orders->service:billing') as GraphEdge
    expect('env' in e).toBe(false)
  })

  it('stamps an incident with its environment, and leaves it off for unknown', () => {
    const failing = call('staging', { kind: 2, statusCode: 2, exception: { type: 'TypeError', message: 'boom' } })
    expect(buildErrorEventForReceiver(failing, ctx.graph)?.env).toBe('staging')
    const unlabelled = call('unknown', { kind: 2, statusCode: 2, exception: { type: 'TypeError', message: 'boom' } })
    expect('env' in (buildErrorEventForReceiver(unlabelled, ctx.graph) ?? {})).toBe(false)
  })

  it('stitches the INFERRED twins in the failing span environment', async () => {
    const g = ctx.graph
    g.addEdgeWithKey('CALLS:service:orders->service:billing', 'service:orders', 'service:billing', {
      id: 'CALLS:service:orders->service:billing',
      source: 'service:orders',
      target: 'service:billing',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    } as GraphEdge)
    await handleSpan(ctx, call('staging', { kind: 2, statusCode: 2, attributes: {} }))
    const inferred = g.getEdgeAttributes('CALLS:INFERRED@staging:service:orders->service:billing') as GraphEdge
    expect(inferred.env).toBe('staging')
  })

  it('never mints an env-tagged twin of a service static extraction knows, even beside one an older daemon left', () => {
    const g = ctx.graph
    g.addNode('service:orders:staging', { id: 'service:orders:staging', type: NodeType.ServiceNode, name: 'orders', language: 'unknown', discoveredVia: 'otel', env: 'staging' } as GraphNode)
    expect(ensureServiceNode(g, 'orders', 'staging')).toBe('service:orders')
    expect(ensureServiceNode(g, 'orders', 'production')).toBe('service:orders')
    expect(g.hasNode('service:orders:production')).toBe(false)
    // An OTel-only service still gets its environment in its id.
    expect(ensureServiceNode(g, 'search', 'staging')).toBe('service:search:staging')
  })

  it('keeps one 4xx burst per environment', async () => {
    process.env.NEAT_INCIDENT_THRESHOLDS = JSON.stringify({ threshold: 2, windowMs: 60_000 })
    try {
      const four = (env: string) => call(env, { attributes: { 'http.method': 'GET', 'server.address': 'billing', 'server.port': 3001, 'http.response.status_code': 404 } })
      const read = async () => (await fs.readFile(ctx.errorsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
      await handleSpan(ctx, four('production'))
      await handleSpan(ctx, four('staging'))
      // One 404 in each environment: neither reached the burst threshold of two.
      expect(await read()).toEqual([])
      // A second production 404 completes production's burst, and only that one.
      await handleSpan(ctx, four('production'))
      const incidents = (await read()).map((l) => JSON.parse(l) as { env?: string })
      expect(incidents.map((i) => i.env)).toEqual(['production'])
    } finally {
      delete process.env.NEAT_INCIDENT_THRESHOLDS
    }
  })
})

describe('v10 → v11 snapshot migration (ADR-280 decision 10)', () => {
  function v10(nodes: Array<[string, Record<string, unknown>]>, edges: Array<Record<string, unknown>>): PersistedGraph {
    return {
      schemaVersion: 10,
      exportedAt: '2026-11-18T00:00:00.000Z',
      graph: {
        options: { type: 'directed', multi: true, allowSelfLoops: false },
        attributes: {},
        nodes: nodes.map(([key, attributes]) => ({ key, attributes })),
        edges: edges.map((a) => ({ key: a.id as string, source: a.source as string, target: a.target as string, attributes: a })),
      } as unknown as PersistedGraph['graph'],
    }
  }
  const svc = (name: string, extra: Record<string, unknown> = {}) => ({ id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'javascript', ...extra })

  it('folds an env-tagged twin into the extracted service, re-keying its runtime edges to the twin environment', () => {
    const before = v10(
      [
        ['service:Orders', svc('Orders')],
        ['service:orders:staging', { ...svc('orders'), id: 'service:orders:staging', discoveredVia: 'otel', env: 'staging' }],
        ['service:billing', svc('billing')],
      ],
      [
        { id: 'CALLS:OBSERVED:service:orders:staging->service:billing', source: 'service:orders:staging', target: 'service:billing', type: 'CALLS', provenance: 'OBSERVED', callCount: 3, signal: { spanCount: 3, errorCount: 1 }, lastObserved: '2026-11-17T10:00:00.000Z' },
        { id: 'CALLS:OBSERVED:service:Orders->service:billing', source: 'service:Orders', target: 'service:billing', type: 'CALLS', provenance: 'OBSERVED', callCount: 5, signal: { spanCount: 5, errorCount: 0 }, lastObserved: '2026-11-17T09:00:00.000Z' },
        { id: 'CALLS:service:Orders->service:billing', source: 'service:Orders', target: 'service:billing', type: 'CALLS', provenance: 'EXTRACTED' },
      ],
    )
    const after = migrateSnapshot(structuredClone(before))
    expect(after.schemaVersion).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(11)
    const g = after.graph as unknown as { nodes: Array<{ key: string }>; edges: Array<{ key: string; source: string; attributes: Record<string, unknown> }> }
    expect(g.nodes.map((n) => n.key).sort()).toEqual(['service:Orders', 'service:billing'])
    const byKey = new Map(g.edges.map((e) => [e.key, e]))
    const staged = byKey.get('CALLS:OBSERVED@staging:service:Orders->service:billing')!
    expect([staged.source, staged.attributes.env, staged.attributes.callCount]).toEqual(['service:Orders', 'staging', 3])
    // The extracted service's own unlabelled evidence is the `unknown` edge, untouched.
    expect(byKey.get('CALLS:OBSERVED:service:Orders->service:billing')!.attributes.callCount).toBe(5)
    expect(byKey.has('CALLS:service:Orders->service:billing')).toBe(true)
    // Idempotent.
    expect(JSON.stringify(migrateSnapshot(structuredClone(after)))).toBe(JSON.stringify(after))
  })

  it('merges a folded edge into one already at its new id', () => {
    const before = v10(
      [
        ['service:orders', svc('orders')],
        ['service:orders:staging', { ...svc('orders'), id: 'service:orders:staging', discoveredVia: 'otel', env: 'staging' }],
        ['service:Orders:Staging', { ...svc('Orders'), id: 'service:Orders:Staging', discoveredVia: 'otel', env: 'Staging' }],
        ['service:billing', svc('billing')],
      ],
      [
        { id: 'CALLS:OBSERVED:service:orders:staging->service:billing', source: 'service:orders:staging', target: 'service:billing', type: 'CALLS', provenance: 'OBSERVED', callCount: 2, signal: { spanCount: 2, errorCount: 1 }, lastObserved: '2026-11-17T08:00:00.000Z' },
        { id: 'CALLS:OBSERVED:service:Orders:Staging->service:billing', source: 'service:Orders:Staging', target: 'service:billing', type: 'CALLS', provenance: 'OBSERVED', callCount: 4, signal: { spanCount: 4, errorCount: 0 }, lastObserved: '2026-11-17T11:00:00.000Z' },
      ],
    )
    const g = migrateSnapshot(before).graph as unknown as { nodes: Array<{ key: string }>; edges: Array<{ key: string; attributes: Record<string, unknown> }> }
    expect(g.nodes.map((n) => n.key).sort()).toEqual(['service:billing', 'service:orders'])
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]!.key).toBe('CALLS:OBSERVED@staging:service:orders->service:billing')
    expect(g.edges[0]!.attributes).toMatchObject({ callCount: 6, signal: { spanCount: 6, errorCount: 1 }, lastObserved: '2026-11-17T11:00:00.000Z', env: 'staging' })
  })

  it('moves an OTel-only service onto its normalised environment id and leaves everything else as it was', () => {
    const before = v10(
      [
        ['service:search:Prod', { ...svc('search'), id: 'service:search:Prod', discoveredVia: 'otel', env: 'Prod' }],
        ['service:billing', svc('billing')],
      ],
      [{ id: 'CALLS:OBSERVED:service:search:Prod->service:billing', source: 'service:search:Prod', target: 'service:billing', type: 'CALLS', provenance: 'OBSERVED', callCount: 1 }],
    )
    const g = migrateSnapshot(before).graph as unknown as { nodes: Array<{ key: string; attributes: Record<string, unknown> }>; edges: Array<{ key: string; attributes: Record<string, unknown> }> }
    expect(g.nodes.map((n) => [n.key, n.attributes.env])).toEqual([['service:search:prod', 'prod'], ['service:billing', undefined]])
    expect(g.edges.map((e) => e.key)).toEqual(['CALLS:OBSERVED:service:search:prod->service:billing'])
    expect('env' in g.edges[0]!.attributes).toBe(false)
  })

  it('changes nothing in a snapshot with no environment twin', () => {
    const before = v10(
      [['service:orders', svc('orders')], ['service:billing', svc('billing')]],
      [{ id: 'CALLS:OBSERVED:service:orders->service:billing', source: 'service:orders', target: 'service:billing', type: 'CALLS', provenance: 'OBSERVED', callCount: 1 }],
    )
    const after = migrateSnapshot(structuredClone(before))
    expect(JSON.stringify(after.graph)).toBe(JSON.stringify(before.graph))
  })
})
