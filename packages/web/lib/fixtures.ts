import type { ErrorEvent, ConnectorSummary, LogEntry } from '@neat.is/types'

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
    // operation nodes — the routes / operations / methods / channels a service
    // actually serves (ADR-119/122/123/125). Minted observed-first from OTel, so
    // they carry lastObserved and render tinted green. The WS channel went quiet,
    // so its edge decayed OBSERVED → STALE while the node stays known.
    { id: 'route:api-gateway:GET /charge', type: 'RouteNode', name: 'GET /charge', method: 'GET', path: '/charge', lastObserved: new Date(Date.now() - 1000 * 60 * 2).toISOString() },
    { id: 'graphql:api-gateway:query orders', type: 'GraphQLOperationNode', name: 'query orders', operationType: 'query', operationName: 'orders', lastObserved: new Date(Date.now() - 1000 * 60 * 4).toISOString() },
    { id: 'grpc:payments.PaymentService/Charge', type: 'GrpcMethodNode', name: 'PaymentService/Charge', rpcService: 'payments.PaymentService', rpcMethod: 'Charge', lastObserved: new Date(Date.now() - 1000 * 60 * 3).toISOString() },
    { id: 'ws:notifications:/live', type: 'WebSocketChannelNode', name: '/live', channel: '/live', lastObserved: new Date(Date.now() - 1000 * 60 * 90).toISOString() },
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
    // OBSERVED edges landing on the operation nodes — the gateway serving each
    // route / operation / method it was seen handling.
    { id: 'CALLS:OBSERVED:gw-proxy->route-charge', source: 'file:api-gateway:src/proxy.ts', target: 'route:api-gateway:GET /charge', type: 'CALLS', provenance: 'OBSERVED', confidence: 0.99, evidence: { file: 'src/proxy.ts', line: 52 }, signal: { spanCount: 42891, errorCount: 12 } },
    { id: 'CALLS:OBSERVED:gw-proxy->gql-orders', source: 'file:api-gateway:src/proxy.ts', target: 'graphql:api-gateway:query orders', type: 'CALLS', provenance: 'OBSERVED', confidence: 0.96, evidence: { file: 'src/proxy.ts', line: 73 }, signal: { spanCount: 6120, errorCount: 0 } },
    { id: 'CALLS:OBSERVED:charge->grpc-charge', source: 'file:checkout:src/routes/charge.ts', target: 'grpc:payments.PaymentService/Charge', type: 'CALLS', provenance: 'OBSERVED', confidence: 0.97, evidence: { file: 'src/routes/charge.ts', line: 140 }, signal: { spanCount: 9210, errorCount: 4 } },
    // a WebSocket channel that went quiet — the CONNECTS_TO liveness edge decayed
    // OBSERVED → STALE (ADR-125). Renders faded/dashed; the legend explains it.
    { id: 'CONNECTS_TO:STALE:gw-proxy->ws-live', source: 'file:api-gateway:src/proxy.ts', target: 'ws:notifications:/live', type: 'CONNECTS_TO', provenance: 'STALE', confidence: 0.7 },
  ],
}

// Shaped to the canonical ErrorEvent envelope (@neat.is/types, ADR-061's
// /api/incidents contract) — affectedNode/errorType/errorMessage/
// exceptionStacktrace, not the nodeId/type/message/stacktrace trio this
// fixture used to carry (#699). id/service/traceId/spanId are required by
// the schema even though the table itself only renders a subset of fields.
export const FIXTURE_INCIDENTS: { count: number; total: number; events: ErrorEvent[] } = {
  count: 3,
  total: 3,
  events: [
    {
      id: 'evt-payments-a1b2c3',
      timestamp: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
      service: 'payments',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      errorType: 'ERR_VERSION_MISMATCH',
      errorMessage: 'pg driver 7.4.0 incompatible with PostgreSQL 15 — connection failed',
      exceptionType: 'Error',
      exceptionStacktrace: 'Error: connect ECONNREFUSED\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1187:16)\n    at pg.Client.connect (/app/node_modules/pg/lib/client.js:54:9)',
      affectedNode: 'file:payments:src/db.ts',
    },
    {
      id: 'evt-checkout-d4e5f6',
      timestamp: new Date(Date.now() - 1000 * 60 * 38).toISOString(),
      service: 'checkout',
      traceId: 'a3ce929d0e0e47364bf92f3577b34da6',
      spanId: '0ba902b700f067aa',
      errorType: 'ERR_TIMEOUT',
      errorMessage: 'upstream payments service exceeded 5s timeout on /charge',
      affectedNode: 'file:checkout:src/routes/charge.ts',
    },
    {
      id: 'evt-auth-g7h8i9',
      timestamp: new Date(Date.now() - 1000 * 60 * 91).toISOString(),
      service: 'auth',
      traceId: '77b34da6a3ce929d0e0e47364bf92f35',
      spanId: '902b700f067aa0ba',
      errorType: 'ERR_RATE_LIMIT',
      errorMessage: 'Redis rate-limit key expired — 429 burst on /token',
      affectedNode: 'file:auth:src/token.ts',
    },
  ],
}

// One connector per state (ADR-137) so the Connectors page's status vocabulary
// has something to show offline — never a resolved secret, only the env-ref
// pointer, matching what a real GET /:project/connectors would return.
export const FIXTURE_CONNECTORS: { connectors: ConnectorSummary[] } = {
  connectors: [
    {
      id: 'cf-prod',
      provider: 'cloudflare',
      credentialRef: '$CLOUDFLARE_API_TOKEN',
      status: {
        state: 'healthy',
        lastPollAt: new Date(Date.now() - 1000 * 45).toISOString(),
        lastOutcome: 'ok',
        lastError: null,
        signalsLastPoll: 12,
      },
    },
    {
      id: 'supabase-main',
      provider: 'supabase',
      credentialRef: '$SUPABASE_SERVICE_KEY',
      status: {
        state: 'healthy',
        lastPollAt: new Date(Date.now() - 1000 * 20).toISOString(),
        lastOutcome: 'ok',
        lastError: null,
        signalsLastPoll: 3,
      },
    },
    {
      id: 'railway-worker',
      provider: 'railway',
      credentialRef: '$RAILWAY_TOKEN',
      status: {
        state: 'error',
        lastPollAt: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
        lastOutcome: 'error',
        lastError: '401 from Railway — token rejected',
        signalsLastPoll: 0,
      },
    },
    {
      id: 'firebase-legacy',
      provider: 'firebase',
      credentialRef: '$FIREBASE_SERVICE_ACCOUNT',
      status: {
        state: 'stale',
        lastPollAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
        lastOutcome: 'ok',
        lastError: null,
        signalsLastPoll: 0,
      },
    },
    {
      id: 'cf-staging',
      provider: 'cloudflare',
      credentialRef: '$CLOUDFLARE_STAGING_TOKEN',
      status: { state: 'idle', lastPollAt: null, lastOutcome: null, lastError: null, signalsLastPoll: 0 },
    },
  ],
}
// A LogEntry per source (logs.md §1) so the Logs page's source filter chips
// have something to narrow in demo mode — native (OTLP) plus one from each
// shipped connector.
export const FIXTURE_LOGS: { count: number; total: number; logs: LogEntry[] } = {
  count: 6,
  total: 6,
  logs: [
    {
      id: 'log-native-a1',
      projectName: 'demo',
      source: 'native',
      serviceName: 'checkout',
      nodeId: 'file:checkout:src/notify.ts',
      timestamp: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
      severity: 'error',
      message: 'notify: upstream notifications service unreachable after 3 retries',
    },
    {
      id: 'log-supabase-b2',
      projectName: 'demo',
      source: 'supabase',
      serviceName: 'auth-db',
      timestamp: new Date(Date.now() - 1000 * 60 * 9).toISOString(),
      severity: 'warn',
      message: 'slow query: select on public.sessions exceeded 800ms',
    },
    {
      id: 'log-railway-c3',
      projectName: 'demo',
      source: 'railway',
      serviceName: 'payments',
      timestamp: new Date(Date.now() - 1000 * 60 * 17).toISOString(),
      severity: 'info',
      message: 'deploy succeeded — payments@2.4.1',
    },
    {
      id: 'log-firebase-d4',
      projectName: 'demo',
      source: 'firebase',
      serviceName: 'auth',
      timestamp: new Date(Date.now() - 1000 * 60 * 26).toISOString(),
      severity: 'error',
      message: 'onCall function auth-verify threw: token signature mismatch',
    },
    {
      id: 'log-cloudflare-e5',
      projectName: 'demo',
      source: 'cloudflare',
      serviceName: 'edge-router',
      timestamp: new Date(Date.now() - 1000 * 60 * 41).toISOString(),
      severity: 'warn',
      message: 'Worker CPU time 47ms approaching the 50ms limit on /api/route',
    },
    {
      id: 'log-vercel-f6',
      projectName: 'demo',
      source: 'vercel',
      serviceName: 'web',
      timestamp: new Date(Date.now() - 1000 * 60 * 58).toISOString(),
      severity: 'debug',
      message: 'edge function cold start — 210ms',
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

// The rule list a project pins into `policy.json` — surfaced read-only on the
// Policies page as "the rules injected into your agent's context." Demo mode
// shows a couple of representative rules so the surface isn't blank offline.
export const FIXTURE_POLICIES = {
  version: 1 as const,
  policies: [
    {
      id: 'db-connection-required',
      name: 'Every service reaches a database',
      description: 'Each ServiceNode must declare a CONNECTS_TO edge to a DatabaseNode.',
      severity: 'warning' as const,
      rule: { type: 'structural' as const, fromNodeType: 'ServiceNode', edgeType: 'CONNECTS_TO', toNodeType: 'DatabaseNode' },
    },
    {
      id: 'drivers-stay-compatible',
      name: 'Drivers stay compatible with their engines',
      description: 'Re-runs the compat check against the live graph on every evaluation.',
      severity: 'error' as const,
      rule: { type: 'compatibility' as const },
    },
    {
      id: 'services-declare-owner',
      name: 'Services declare an owner',
      description: 'Every ServiceNode carries a non-empty owner field (from package.json / pyproject.toml).',
      severity: 'info' as const,
      rule: { type: 'ownership' as const, nodeType: 'ServiceNode', field: 'owner' },
    },
  ],
}

// A DivergenceResult (divergence.ts) over the fixture graph: two declared/
// observed mismatches the demo can show offline. One missing-observed (a
// declared edge production never exercised) and one host-mismatch (declared
// host vs. the host runtime actually connected to).
export const FIXTURE_DIVERGENCES = {
  divergences: [
    {
      type: 'missing-observed' as const,
      source: 'file:checkout:src/notify.ts',
      target: 'service:notifications',
      confidence: 0.9,
      reason: 'Declared CALLS to notifications has no observed twin — production never exercised this path.',
      recommendation: 'Drive traffic through the notify path, or remove the dead call if it is no longer reachable.',
      edgeType: 'CALLS' as const,
      extracted: {
        id: 'CALLS:EXTRACTED:notify->notifications',
        source: 'file:checkout:src/notify.ts',
        target: 'service:notifications',
        type: 'CALLS' as const,
        provenance: 'EXTRACTED' as const,
        confidence: 0.9,
        evidence: { file: 'src/notify.ts', line: 22 },
      },
    },
    {
      type: 'host-mismatch' as const,
      source: 'file:auth:src/db.ts',
      target: 'database:auth-db.internal',
      confidence: 0.82,
      reason: 'Declared host auth-db.internal, but runtime connected to auth-db.prod.internal.',
      recommendation: 'Reconcile the connection string with the host production actually reaches.',
      extractedHost: 'auth-db.internal',
      observedHost: 'auth-db.prod.internal',
    },
  ],
  totalAffected: 2,
  computedAt: new Date().toISOString(),
}

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

// The transitive-dependencies DEMO fallback (TransitiveDependenciesResult) — the
// outbound edges from a node, shaped like the daemon's `/graph/dependencies`.
export function fixtureDependencies(id: string) {
  const deps = FIXTURE_GRAPH.edges
    .filter((e) => e.source === id && e.type !== 'CONTAINS')
    .map((e) => ({ nodeId: e.target, distance: 1, edgeType: e.type, provenance: e.provenance }))
  return { origin: id, depth: 10, dependencies: deps, total: deps.length }
}
