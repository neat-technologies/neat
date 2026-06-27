// Fixture data returned when NEAT_DEMO=1 and core is unreachable.
// File-first graph (file-awareness.md §1-§3): FileNodes are the primary
// nodes, CALLS edges originate from files, and `service ──CONTAINS──▶ file`
// expresses ownership. CONNECTS_TO to databases/infra also originates from
// the file that opens the connection. The dashboard collapses services by
// default and expands to these files on drill-down.

export const FIXTURE_GRAPH = {
  nodes: [
    // services — collapsed containers in the top view
    { id: 'service:checkout', type: 'ServiceNode', name: 'checkout', language: 'TypeScript', version: '2.4.1' },
    { id: 'service:payments', type: 'ServiceNode', name: 'payments', language: 'TypeScript', version: '1.2.0' },
    { id: 'service:auth', type: 'ServiceNode', name: 'auth', language: 'TypeScript', version: '3.0.0' },
    { id: 'service:api-gateway', type: 'ServiceNode', name: 'api-gateway', language: 'TypeScript', version: '1.0.5' },
    { id: 'service:notifications', type: 'ServiceNode', name: 'notifications', language: 'Python', version: '1.1.0' },
    // files — revealed when a service is opened
    { id: 'file:checkout:src/routes/charge.ts', type: 'FileNode', service: 'checkout', path: 'src/routes/charge.ts', language: 'ts' },
    { id: 'file:checkout:src/lib/cache.ts', type: 'FileNode', service: 'checkout', path: 'src/lib/cache.ts', language: 'ts' },
    { id: 'file:checkout:src/notify.ts', type: 'FileNode', service: 'checkout', path: 'src/notify.ts', language: 'ts' },
    { id: 'file:payments:src/db.ts', type: 'FileNode', service: 'payments', path: 'src/db.ts', language: 'ts' },
    { id: 'file:auth:src/token.ts', type: 'FileNode', service: 'auth', path: 'src/token.ts', language: 'ts' },
    { id: 'file:auth:src/db.ts', type: 'FileNode', service: 'auth', path: 'src/db.ts', language: 'ts' },
    { id: 'file:api-gateway:src/proxy.ts', type: 'FileNode', service: 'api-gateway', path: 'src/proxy.ts', language: 'ts' },
    // datastores + infra
    { id: 'database:payments-db.internal', type: 'DatabaseNode', name: 'payments-db', host: 'payments-db.internal', port: 5432, engine: 'postgresql', engineVersion: '15.2', compatibleDrivers: [] },
    { id: 'database:auth-db.internal', type: 'DatabaseNode', name: 'auth-db', host: 'auth-db.internal', port: 5432, engine: 'postgresql', engineVersion: '14.8', compatibleDrivers: [] },
    { id: 'infra:redis:cache.internal', type: 'InfraNode', name: 'cache', kind: 'cache', provider: 'redis' },
  ],
  edges: [
    // service ──CONTAINS──▶ file (structural ownership, not traffic)
    { id: 'CONTAINS:checkout->charge', source: 'service:checkout', target: 'file:checkout:src/routes/charge.ts', type: 'CONTAINS', provenance: 'EXTRACTED', confidence: 1.0 },
    { id: 'CONTAINS:checkout->cache', source: 'service:checkout', target: 'file:checkout:src/lib/cache.ts', type: 'CONTAINS', provenance: 'EXTRACTED', confidence: 1.0 },
    { id: 'CONTAINS:checkout->notify', source: 'service:checkout', target: 'file:checkout:src/notify.ts', type: 'CONTAINS', provenance: 'EXTRACTED', confidence: 1.0 },
    { id: 'CONTAINS:payments->db', source: 'service:payments', target: 'file:payments:src/db.ts', type: 'CONTAINS', provenance: 'EXTRACTED', confidence: 1.0 },
    { id: 'CONTAINS:auth->token', source: 'service:auth', target: 'file:auth:src/token.ts', type: 'CONTAINS', provenance: 'EXTRACTED', confidence: 1.0 },
    { id: 'CONTAINS:auth->db', source: 'service:auth', target: 'file:auth:src/db.ts', type: 'CONTAINS', provenance: 'EXTRACTED', confidence: 1.0 },
    { id: 'CONTAINS:gw->proxy', source: 'service:api-gateway', target: 'file:api-gateway:src/proxy.ts', type: 'CONTAINS', provenance: 'EXTRACTED', confidence: 1.0 },
    // CALLS originate from files, with file:line evidence
    { id: 'CALLS:OBSERVED:gw-proxy->charge', source: 'file:api-gateway:src/proxy.ts', target: 'file:checkout:src/routes/charge.ts', type: 'CALLS', provenance: 'OBSERVED', confidence: 0.98, callCount: 42891, evidence: { file: 'src/proxy.ts', line: 64 }, signal: { spanCount: 42891, errorCount: 12 } },
    { id: 'CALLS:OBSERVED:gw-proxy->token', source: 'file:api-gateway:src/proxy.ts', target: 'file:auth:src/token.ts', type: 'CALLS', provenance: 'OBSERVED', confidence: 0.97, callCount: 18204, evidence: { file: 'src/proxy.ts', line: 81 }, signal: { spanCount: 18204, errorCount: 3 } },
    { id: 'CALLS:OBSERVED:charge->payments-db', source: 'file:checkout:src/routes/charge.ts', target: 'file:payments:src/db.ts', type: 'CALLS', provenance: 'OBSERVED', confidence: 0.95, callCount: 9341, evidence: { file: 'src/routes/charge.ts', line: 118 }, signal: { spanCount: 9341, errorCount: 421 } },
    { id: 'CALLS:EXTRACTED:notify->notifications', source: 'file:checkout:src/notify.ts', target: 'service:notifications', type: 'CALLS', provenance: 'EXTRACTED', confidence: 0.9, evidence: { file: 'src/notify.ts', line: 22 } },
    // connections to datastores + infra, file-grained
    { id: 'CONNECTS_TO:OBSERVED:payments-db->pg', source: 'file:payments:src/db.ts', target: 'database:payments-db.internal', type: 'CONNECTS_TO', provenance: 'OBSERVED', confidence: 1.0, evidence: { file: 'src/db.ts', line: 9 } },
    { id: 'CONNECTS_TO:EXTRACTED:auth-db->pg', source: 'file:auth:src/db.ts', target: 'database:auth-db.internal', type: 'CONNECTS_TO', provenance: 'EXTRACTED', confidence: 0.95, evidence: { file: 'src/db.ts', line: 11 } },
    { id: 'CONNECTS_TO:INFERRED:checkout-cache->redis', source: 'file:checkout:src/lib/cache.ts', target: 'infra:redis:cache.internal', type: 'CONNECTS_TO', provenance: 'INFERRED', confidence: 0.6 },
    { id: 'CONNECTS_TO:INFERRED:auth-token->redis', source: 'file:auth:src/token.ts', target: 'infra:redis:cache.internal', type: 'CONNECTS_TO', provenance: 'INFERRED', confidence: 0.6 },
  ],
}

export const FIXTURE_INCIDENTS = {
  count: 3,
  total: 3,
  events: [
    {
      nodeId: 'service:payments',
      timestamp: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
      type: 'ERR_VERSION_MISMATCH',
      message: 'pg driver 7.4.0 incompatible with PostgreSQL 15 — connection failed',
      stacktrace: 'Error: connect ECONNREFUSED\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1187:16)\n    at pg.Client.connect (/app/node_modules/pg/lib/client.js:54:9)',
    },
    {
      nodeId: 'service:checkout',
      timestamp: new Date(Date.now() - 1000 * 60 * 38).toISOString(),
      type: 'ERR_TIMEOUT',
      message: 'upstream payments service exceeded 5s timeout on /charge',
    },
    {
      nodeId: 'service:auth',
      timestamp: new Date(Date.now() - 1000 * 60 * 91).toISOString(),
      type: 'ERR_RATE_LIMIT',
      message: 'Redis rate-limit key expired — 429 burst on /token',
    },
  ],
}

export const FIXTURE_HEALTH = { ok: true, project: 'demo' }

export const FIXTURE_PROJECTS = [
  { name: 'demo', path: '/workspace/demo', status: 'active' as const },
]

// ADR-101 — the daemon-discovery enumerator's DEMO fixture. One profile for the
// demo daemon; the endpoint is illustrative (the proxy serves fixtures in DEMO
// rather than reaching it).
export const FIXTURE_PROFILES = [
  { project: 'demo', endpoint: 'http://127.0.0.1:8080', status: 'running' as const },
]

export const FIXTURE_VIOLATIONS = { violations: [] }

// A node's searchable / display name. FileNodes carry `path` rather than
// `name`, so fall back to it (then to the id) — keeps search file-aware.
function fixtureNodeLabel(n: { name?: string; path?: string; id: string }): string {
  return n.name ?? n.path ?? n.id
}

export function fixtureSearch(q: string) {
  const lower = q.toLowerCase()
  const results = FIXTURE_GRAPH.nodes
    .filter((n) => fixtureNodeLabel(n).toLowerCase().includes(lower) || n.id.toLowerCase().includes(lower))
    .map((n) => ({ node: { id: n.id, type: n.type, name: fixtureNodeLabel(n) }, score: 0.95 }))
  return { results }
}

export function fixtureNodeDetail(id: string) {
  const node = FIXTURE_GRAPH.nodes.find((n) => n.id === id)
  if (!node) return { error: 'not found' }
  return { node }
}

export function fixtureRootCause(id: string) {
  if (id === 'service:payments') {
    return {
      origin: id,
      rootCauseNode: 'database:payments-db.internal',
      reason: 'pg driver 7.4.0 is incompatible with PostgreSQL 15 — protocol mismatch causes connection failure',
      fixRecommendation: 'upgrade pg to ^8.x (supports PostgreSQL 15 protocol)',
      confidence: 0.87,
      traversalPath: [id, 'database:payments-db.internal'],
    }
  }
  return { origin: id, rootCauseNode: null, reason: '', fixRecommendation: null, confidence: 0, traversalPath: [] }
}

export function fixtureBlastRadius(id: string) {
  const downstream = FIXTURE_GRAPH.edges
    .filter((e) => e.source === id)
    .map((e) => ({ nodeId: e.target, distance: 1, confidence: e.confidence, path: [id, e.target] }))
  return { origin: id, affectedNodes: downstream, violationCount: 0 }
}
