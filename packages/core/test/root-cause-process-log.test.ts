import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent } from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getRootCause } from '../src/traverse.js'
import { mergeObservedDeployContext } from '../src/ingest.js'
import { firstErrorLine, dependencyNamedInLog, stripAnsi } from '../src/process-log.js'

// #1474 / ADR-262 — SREGym revoke_auth_mongodb-1 on hotel-reservation. geo
// crash-loops because its database user lost its role, and its process log says so.
// Root cause stopped at "geo: its own deploy is failing". The verdict now reads the
// fused process log: the first error line goes into the reason, and the dependency
// the log names, among those geo reaches, is pointed at as the origin.

const NOW = Date.parse('2026-10-17T16:22:00.000Z')
const E = '\x1b'

// geo's log as `kubectl logs` returned it on the bench (zerolog console output,
// colour escapes included).
const GEO_LOG = [
  '{"level":"info","time":"2026-10-17T16:21:30Z","message":"TLS disabled."}',
  '{"level":"info","time":"2026-10-17T16:21:30Z","message":"Set global log level: info"}',
  `${E}[90m2026-10-17T16:21:30Z${E}[0m ${E}[32mINF${E}[0m ${E}[1mcmd/geo/main.go:23${E}[0m${E}[36m >${E}[0m Reading config...`,
  `${E}[90m2026-10-17T16:21:30Z${E}[0m ${E}[32mINF${E}[0m ${E}[1mcmd/geo/main.go:36${E}[0m${E}[36m >${E}[0m Read database URL: mongodb-geo:27017`,
  `${E}[90m2026-10-17T16:21:30Z${E}[0m ${E}[32mINF${E}[0m ${E}[1mcmd/geo/main.go:37${E}[0m${E}[36m >${E}[0m Initializing DB connection...`,
  `${E}[90m2026-10-17T16:21:30Z${E}[0m ${E}[32mINF${E}[0m ${E}[1mcmd/geo/db.go:33${E}[0m${E}[36m >${E}[0m New session successfull...`,
  `${E}[90m2026-10-17T16:21:30Z${E}[0m ${E}[1m${E}[31mFTL${E}[0m${E}[0m ${E}[1mcmd/geo/db.go:39${E}[0m${E}[36m >${E}[0m not authorized on geo-db to execute command { count: "geo", query: { hotelId: "1" }, $db: "geo-db" }`,
].join('\n')

const FTL_LINE =
  'FTL cmd/geo/db.go:39 > not authorized on geo-db to execute command { count: "geo", query: { hotelId: "1" }, $db: "geo-db" }'

function edge(g: NeatGraph, type: string, from: string, to: string, extra: Partial<GraphEdge> = {}): void {
  const key = `${type}:${from}->${to}`
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type,
    provenance: Provenance.EXTRACTED,
    ...extra,
  } as GraphEdge)
}

// hotel as extraction leaves it: geo owns docker-compose.yml, whose service block
// lists every mongodb (so the file CONNECTS_TO all of them), and geo DEPENDS_ON its
// own mongodb container. search calls geo's method; mongodb-user is also in the
// graph, reached by user, not by geo.
function hotel(log: string | undefined): { g: NeatGraph; incidents: ErrorEvent[] } {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const s of ['geo', 'search', 'user']) {
    g.addNode(`service:${s}`, { id: `service:${s}`, type: NodeType.ServiceNode, name: s, language: 'go' } as GraphNode)
  }
  for (const d of ['mongodb-geo', 'mongodb-rate', 'mongodb-user']) {
    g.addNode(`database:${d}`, {
      id: `database:${d}`,
      type: NodeType.DatabaseNode,
      name: d,
      engine: 'mongodb',
      engineVersion: '5.0',
      compatibleDrivers: [],
      host: d,
    } as unknown as GraphNode)
  }
  g.addNode('infra:mongodb:mongodb-geo', {
    id: 'infra:mongodb:mongodb-geo',
    type: NodeType.InfraNode,
    name: 'mongodb-geo',
    provider: 'self',
    kind: 'mongodb',
  } as unknown as GraphNode)
  g.addNode('file:geo:docker-compose.yml', {
    id: 'file:geo:docker-compose.yml',
    type: NodeType.FileNode,
    path: 'docker-compose.yml',
    service: 'geo',
  } as unknown as GraphNode)
  edge(g, EdgeType.CONTAINS, 'service:geo', 'file:geo:docker-compose.yml')
  edge(g, EdgeType.CONNECTS_TO, 'file:geo:docker-compose.yml', 'database:mongodb-geo')
  edge(g, EdgeType.CONNECTS_TO, 'file:geo:docker-compose.yml', 'database:mongodb-rate')
  edge(g, EdgeType.DEPENDS_ON, 'service:geo', 'infra:mongodb:mongodb-geo')
  edge(g, EdgeType.CONNECTS_TO, 'service:user', 'database:mongodb-user')
  edge(g, EdgeType.CALLS, 'service:search', 'service:geo', {
    provenance: Provenance.OBSERVED,
    callCount: 40,
    signal: { spanCount: 40, errorCount: 12 },
    lastObserved: '2026-10-17T16:21:50.000Z',
  } as Partial<GraphEdge>)

  const id = 'k8s:deploy:hotel-reservation:geo:crash-loop'
  const incidents: ErrorEvent[] = [
    {
      id,
      timestamp: '2026-10-17T16:21:30Z',
      service: 'geo',
      affectedNode: 'service:geo',
      errorType: 'k8s-deploy-failure',
      errorMessage: 'Deployment geo is crashlooping (restarts: 3); last terminated: Error (exit 1)',
    } as ErrorEvent,
  ]
  mergeObservedDeployContext(g, 'service:geo', id, '2026-10-17T16:21:30Z', {
    fault: 'crash-loop',
    waitingReason: 'CrashLoopBackOff',
    restartCount: 3,
    terminatedReason: 'Error',
    exitCode: 1,
    ...(log !== undefined ? { processLog: log } : {}),
  })
  return { g, incidents }
}

describe('process log reader (ADR-262)', () => {
  it('strips colour escapes and finds the first error line by level', () => {
    expect(stripAnsi(`${E}[31mFTL${E}[0m x`)).toBe('FTL x')
    const err = firstErrorLine(GEO_LOG)!
    expect(err.line).toBe(FTL_LINE)
    expect(err.index).toBe(6)
  })

  it('reads JSON records by their level field', () => {
    const log = '{"level":"info","msg":"starting"}\n{"level":"error","msg":"dial tcp 10.0.0.4:5432: connect: connection refused"}'
    expect(firstErrorLine(log)?.line).toBe('dial tcp 10.0.0.4:5432: connect: connection refused')
  })

  it('takes the exception line that closes a traceback', () => {
    const log = [
      'INFO starting worker',
      'Traceback (most recent call last):',
      '  File "app.py", line 12, in <module>',
      '    client.admin.command("ping")',
      'OperationFailure: Authentication failed., full error: {...}',
    ].join('\n')
    expect(firstErrorLine(log)?.line).toBe('OperationFailure: Authentication failed., full error: {...}')
  })

  it('reads a Go panic and a level=error pair; a clean log has none', () => {
    expect(firstErrorLine('boot\npanic: runtime error: invalid memory address')?.line).toBe(
      'panic: runtime error: invalid memory address',
    )
    expect(firstErrorLine('time=x level=error msg="redis down"')?.line).toBe('time=x level=error msg="redis down"')
    expect(firstErrorLine('INF ready\nINF serving on :8083')).toBeNull()
  })

  it('names a dependency only on a whole token, error line first, then the lines before it', () => {
    const cands = [
      { id: 'database:mongodb-geo', names: ['mongodb-geo'], rank: 0 },
      { id: 'database:geo', names: ['geo'], rank: 0 },
    ]
    const named = dependencyNamedInLog(GEO_LOG, firstErrorLine(GEO_LOG)!, cands)
    // `geo` occurs in the error line only inside `geo-db` and `"geo"` quoted — the
    // quoted one is a whole token, so it would match; the bound to the seed's own
    // dependencies is what keeps a name like that out (see the getRootCause cases).
    expect(named?.id).toBe('database:geo')
    const onlyHost = dependencyNamedInLog(GEO_LOG, firstErrorLine(GEO_LOG)!, [cands[0]!])
    expect(onlyHost).toEqual({
      id: 'database:mongodb-geo',
      line: 'INF cmd/geo/main.go:36 > Read database URL: mongodb-geo:27017',
      inErrorLine: false,
    })
  })
})

describe('getRootCause reads the seed’s process log (ADR-262)', () => {
  it('revoke_auth_mongodb-1: points at database:mongodb-geo, OBSERVED, with both log lines', () => {
    const { g, incidents } = hotel(GEO_LOG)
    const res = getRootCause(g, 'service:geo', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('database:mongodb-geo')
    expect(res.rootCauseReason).toContain(`"${FTL_LINE}"`)
    expect(res.rootCauseReason).toContain('after "INF cmd/geo/main.go:36 > Read database URL: mongodb-geo:27017"')
    expect(res.rootCauseReason).toContain('crash-loop (CrashLoopBackOff, restarts 3, last exit 1, Error)')
    expect(res.rootCauseReason).not.toMatch(/mongo(?!db-)/i) // no provider wording beyond the node's own name
    expect(res.traversalPath.slice(-2)).toEqual(['service:geo', 'database:mongodb-geo'])
    expect(res.edgeProvenances[res.edgeProvenances.length - 1]).toBe(Provenance.OBSERVED)
    expect(res.candidates?.[0]).toMatchObject({ node: 'database:mongodb-geo', classification: 'primary-failure', provenance: Provenance.OBSERVED })
    expect(res.candidates?.[1]).toMatchObject({ node: 'service:geo', classification: 'symptom-only', provenance: Provenance.OBSERVED })
    expect(res.fixRecommendation).toContain('Check mongodb-geo')
  })

  it('an error line that names the dependency itself is the only evidence', () => {
    const log = 'INF boot\nERR dial tcp mongodb-geo:27017: i/o timeout'
    const res = getRootCause(hotel(log).g, 'service:geo', undefined, hotel(log).incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('database:mongodb-geo')
    expect(res.rootCauseReason).toContain('"ERR dial tcp mongodb-geo:27017: i/o timeout".')
    expect(res.rootCauseReason).not.toContain('after "')
  })

  it('a log that names nothing geo reaches keeps geo, with the error line as the why', () => {
    const log = 'INF Reading config...\nFTL missing required key "consulAddress"'
    const { g, incidents } = hotel(log)
    const res = getRootCause(g, 'service:geo', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('service:geo')
    expect(res.rootCauseReason).toContain('Its process log reads "FTL missing required key "consulAddress""')
  })

  it('a dependency that goes by geo’s own name is not taken from the line', () => {
    const { g, incidents } = hotel('FTL not authorized on geo-db to execute command { count: "geo" }')
    g.addNode('infra:k8s-service:geo', { id: 'infra:k8s-service:geo', type: NodeType.InfraNode, name: 'geo', provider: 'kubernetes', kind: 'k8s-service' } as unknown as GraphNode)
    edge(g, EdgeType.DEPENDS_ON, 'service:geo', 'infra:k8s-service:geo')
    expect(getRootCause(g, 'service:geo', undefined, incidents, { now: NOW })!.rootCauseNode).toBe('service:geo')
  })

  it('a node in the graph that geo does not reach is never named', () => {
    const log = 'INF Read database URL: mongodb-user:27017\nFTL not authorized on user-db'
    const { g, incidents } = hotel(log)
    expect(getRootCause(g, 'service:geo', undefined, incidents, { now: NOW })!.rootCauseNode).toBe('service:geo')
  })

  it('with no process log, the verdict is unchanged', () => {
    const { g, incidents } = hotel(undefined)
    const res = getRootCause(g, 'service:geo', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('service:geo')
    expect(res.rootCauseReason).toContain('Its deploy context (env, args, process log) holds the why.')
  })
})
