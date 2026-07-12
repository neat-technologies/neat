import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  infraId,
  observedEdgeId,
  serviceId,
  type GraphEdge,
  type GraphNode,
  type InfraNode,
  type ServiceNode,
} from '@neat.is/types'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import {
  SupabaseConnector,
  createSupabaseConnector,
  createSupabaseResolveTarget,
  describeSupabasePostgresSurfaceFailure,
  diffPgStatStatementsToSignals,
  fetchSupabaseEdgeLogs,
  mapEdgeLogRowsToSignals,
  tableNameFromQueryText,
  targetFromRestPath,
  type PgStatStatementsRow,
  type StatementBaseline,
  type SupabaseConnectorConfig,
  type SupabaseEdgeLogRow,
} from '../src/connectors/supabase/index.js'
import type { NeatGraph } from '../src/graph.js'
import logsAllFixture from './fixtures/supabase/logs-all-response.json' with { type: 'json' }
import pgStatStatementsFixture from './fixtures/supabase/pg-stat-statements.json' with { type: 'json' }

// Fixture shapes confirmed live during this connector's build (docs/contracts/
// connectors.md §5 — real provider response shapes, not synthetic ones):
//   - the `{ result: [...] }` envelope: api.supabase.com/api/v1-json's
//     AnalyticsResponse schema (operationId v1-get-project-logs-all)
//   - each row's method/path/status_code fields: the worked `cross join
//     unnest(...)` queries on supabase.com/docs/guides/telemetry/logs,
//     .../advanced-log-filtering, and .../troubleshooting/discovering-and-
//     interpreting-api-errors-in-the-logs-7xREI9
//   - pg_stat_statements column names + bigint-as-string shape:
//     postgresql.org/docs/current/pgstatstatements.html (Table F.22) and
//     node-postgres's own documented default bigint parsing behavior
const LOG_ROWS = logsAllFixture.result as SupabaseEdgeLogRow[]
const STATEMENT_ROWS = pgStatStatementsFixture as PgStatStatementsRow[]

const NEAT_SERVICE = 'orders-api'
const API_PROJECT_REF = 'abcdefghijklmnopqrst'
const NODE_REF = `${API_PROJECT_REF}.supabase.co`

function config(overrides: Partial<SupabaseConnectorConfig> = {}): SupabaseConnectorConfig {
  return {
    apiProjectRef: API_PROJECT_REF,
    nodeRef: NODE_REF,
    serviceName: NEAT_SERVICE,
    ...overrides,
  }
}

function newGraph(opts: { projectNode?: boolean; tableNode?: boolean } = {}): NeatGraph {
  const { projectNode = true, tableNode = false } = opts
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })

  const service: ServiceNode = {
    id: serviceId(NEAT_SERVICE),
    type: NodeType.ServiceNode,
    name: NEAT_SERVICE,
    language: 'typescript',
  }
  g.addNode(service.id, service)

  if (projectNode) {
    // The project-level InfraNode extract/calls/supabase.ts already mints
    // today from a `createClient('https://abcdefghijklmnopqrst.supabase.co',
    // key)` call — the fallback target this connector's resolveTarget lands
    // on until a future extractor cut adds `.from()`/`.rpc()` parsing
    // (docs/connectors/supabase.md §Static extractor gap).
    const node: InfraNode = {
      id: infraId('supabase', NODE_REF),
      type: NodeType.InfraNode,
      name: NODE_REF,
      provider: 'self',
      kind: 'supabase',
    }
    g.addNode(node.id, node)
  }

  if (tableNode) {
    // Stands in for a *future* extractor cut that parses `.from('orders')` —
    // proves fusion sharpens automatically once that node exists, with no
    // change to this connector (ADR-124's "the fusion payoff compounds once a
    // follow-up issue extends the extractor to match").
    const node: InfraNode = {
      id: infraId('supabase-table', `${NODE_REF}/orders`),
      type: NodeType.InfraNode,
      name: `${NODE_REF}/orders`,
      provider: 'self',
      kind: 'supabase-table',
    }
    g.addNode(node.id, node)
  }

  return g
}

function baseCtx(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    projectDir: '/repo/orders-api',
    credentials: { managementToken: 'not-a-real-management-token' },
    ...overrides,
  }
}

describe('Supabase connector — edge_logs mapping, table + RPC grain (docs/connectors/supabase.md §Fusion)', () => {
  it('parses /rest/v1/<table> into a table-grain signal, aggregating repeats and counting the 5xx as an error', () => {
    const signals = mapEdgeLogRowsToSignals(LOG_ROWS)

    const orders = signals.find((s) => s.targetKind === 'supabase-table' && s.targetName === 'orders')
    expect(orders).toBeDefined()
    expect(orders?.callCount).toBe(2)
    expect(orders?.errorCount).toBe(1)
    expect(orders?.lastObservedIso).toBe('2026-07-03T10:00:05.250000Z')
    expect(orders?.callSite).toBeUndefined()
  })

  it('parses /rest/v1/rpc/<fn> into an RPC-grain signal, distinct from the table pattern', () => {
    const signals = mapEdgeLogRowsToSignals(LOG_ROWS)

    const getTotals = signals.find((s) => s.targetKind === 'supabase-rpc' && s.targetName === 'get_totals')
    expect(getTotals).toBeDefined()
    expect(getTotals?.callCount).toBe(1)
    expect(getTotals?.errorCount).toBe(0)
  })

  it('drops a non-REST path honestly — Auth/Storage/Realtime/Functions traffic is out of scope for this cut', () => {
    const signals = mapEdgeLogRowsToSignals(LOG_ROWS)

    // Exactly 2 signals from 4 fixture rows: the /auth/v1/token row never
    // becomes a fabricated table/RPC target.
    expect(signals).toHaveLength(2)
  })

  it('targetFromRestPath checks the rpc shape before the bare table shape, and returns null for anything else', () => {
    expect(targetFromRestPath('/rest/v1/rpc/get_totals')).toEqual({ targetKind: 'supabase-rpc', name: 'get_totals' })
    expect(targetFromRestPath('/rest/v1/orders')).toEqual({ targetKind: 'supabase-table', name: 'orders' })
    expect(targetFromRestPath('/rest/v1/orders?select=*')).toEqual({ targetKind: 'supabase-table', name: 'orders' })
    expect(targetFromRestPath('/auth/v1/token')).toBeNull()
    expect(targetFromRestPath('/storage/v1/object/avatars/x.png')).toBeNull()
  })
})

describe('Supabase connector — pg_stat_statements mapping and delta diffing (docs/connectors/supabase.md §Surfaces used #2)', () => {
  it('establishes a baseline on first sighting, emitting no signal for a lifetime-cumulative counter it has no floor to diff against', () => {
    const baselines = new Map<string, StatementBaseline>()
    const signals = diffPgStatStatementsToSignals(STATEMENT_ROWS, baselines, '2026-07-03T10:00:00.000Z')

    expect(signals).toEqual([])
    expect(baselines.get('1234567890123456789')).toEqual({ calls: 42 })
    expect(baselines.get('9876543210987654321')).toEqual({ calls: 10 })
  })

  it('diffs a second poll against the stored baseline, emitting only this window\'s delta as callCount', () => {
    const baselines = new Map<string, StatementBaseline>()
    diffPgStatStatementsToSignals(STATEMENT_ROWS, baselines, '2026-07-03T10:00:00.000Z')

    // Simulate the next poll: the orders statement ran 8 more times; the
    // profiles statement saw no new activity.
    const nextRows: PgStatStatementsRow[] = STATEMENT_ROWS.map((r) =>
      r.queryid === '1234567890123456789' ? { ...r, calls: '50', rows: '50' } : r,
    )
    const signals = diffPgStatStatementsToSignals(nextRows, baselines, '2026-07-03T10:01:00.000Z')

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      targetKind: 'supabase-table',
      targetName: 'orders',
      callCount: 8,
      errorCount: 0,
      lastObservedIso: '2026-07-03T10:01:00.000Z',
    })
    expect(baselines.get('1234567890123456789')).toEqual({ calls: 50 })
  })

  it('treats a decreased calls count as a counter reset, establishing a fresh baseline rather than a negative delta', () => {
    const baselines = new Map<string, StatementBaseline>([['1234567890123456789', { calls: 100 }]])
    const signals = diffPgStatStatementsToSignals(STATEMENT_ROWS, baselines, '2026-07-03T10:00:00.000Z')

    // calls (42) < prior baseline (100) — pg_stat_statements_reset() or a
    // restart, not 42 fewer calls than before.
    expect(signals.find((s) => s.targetName === 'orders')).toBeUndefined()
    expect(baselines.get('1234567890123456789')).toEqual({ calls: 42 })
  })

  it('drops a queryid missing from the current poll\'s rows from the baseline map, so a later reappearance starts fresh', () => {
    const baselines = new Map<string, StatementBaseline>([
      ['1234567890123456789', { calls: 42 }],
      ['queryid-evicted', { calls: 999 }],
    ])
    diffPgStatStatementsToSignals(STATEMENT_ROWS, baselines, '2026-07-03T10:00:00.000Z')

    expect(baselines.has('queryid-evicted')).toBe(false)
  })

  it('tableNameFromQueryText extracts a schema-qualified PostgREST table name, and drops non-SELECT/system-schema queries honestly', () => {
    expect(tableNameFromQueryText('SELECT "id", "amount" FROM "public"."orders" WHERE "id" = $1')).toBe('orders')
    expect(tableNameFromQueryText('SELECT "id" FROM "profiles" WHERE "user_id" = $1')).toBe('profiles')
    // No FROM clause at all (an INSERT) — pg_stat_statements carries no table
    // column to fall back on, so this is an honest miss, never guessed.
    expect(tableNameFromQueryText('INSERT INTO "public"."audit_log" ("event") VALUES ($1)')).toBeNull()
    // A pg_catalog / system-schema read — never attributed to a user table.
    expect(tableNameFromQueryText('SELECT count(*) FROM pg_stat_activity')).toBeNull()
  })

  it('pg_stat_statements-grain signal mapping end to end: fixture rows -> baseline -> delta -> ObservedSignal', () => {
    const baselines = new Map<string, StatementBaseline>()
    // First poll: baseline only.
    expect(diffPgStatStatementsToSignals(STATEMENT_ROWS, baselines, '2026-07-03T10:00:00.000Z')).toEqual([])

    // Second poll: orders ran 8 more times, profiles/audit_log/pg_stat_activity
    // unchanged or unattributable.
    const nextRows: PgStatStatementsRow[] = STATEMENT_ROWS.map((r) =>
      r.queryid === '1234567890123456789' ? { ...r, calls: '50' } : r,
    )
    const signals = diffPgStatStatementsToSignals(nextRows, baselines, '2026-07-03T10:01:00.000Z')
    expect(signals).toEqual([
      {
        targetKind: 'supabase-table',
        targetName: 'orders',
        callCount: 8,
        errorCount: 0,
        lastObservedIso: '2026-07-03T10:01:00.000Z',
      },
    ])
  })
})

describe('Supabase connector — target resolution (resolve.ts, docs/connectors/supabase.md §Fusion)', () => {
  it('resolves to the table/RPC InfraNode when a future extractor has already minted one — fusion sharpens automatically, no connector change', () => {
    const graph = newGraph({ projectNode: true, tableNode: true })
    const resolveTarget = createSupabaseResolveTarget(graph, config())

    const resolved = resolveTarget(
      { targetKind: 'supabase-table', targetName: 'orders', callCount: 2, errorCount: 1, lastObservedIso: 'x' },
      baseCtx(),
    )

    expect(resolved).toEqual({
      targetNodeId: infraId('supabase-table', `${NODE_REF}/orders`),
      serviceName: NEAT_SERVICE,
      edgeType: EdgeType.CALLS,
    })
  })

  it('falls back to the project-level InfraNode honestly when no static call site exists for this table/RPC — today\'s expected state (supabase.md §Static extractor gap)', () => {
    const graph = newGraph({ projectNode: true, tableNode: false })
    const resolveTarget = createSupabaseResolveTarget(graph, config())

    const resolved = resolveTarget(
      { targetKind: 'supabase-table', targetName: 'orders', callCount: 2, errorCount: 1, lastObservedIso: 'x' },
      baseCtx(),
    )

    // Explicitly NOT the table-grain id — the extractor only recognizes
    // `createClient(...)`, not `.from()`/`.rpc()` (extract/calls/supabase.ts),
    // so this lands on the coarser project-level node the current extractor
    // already mints, honestly, rather than the file-grained target the
    // design doc describes as the eventual (not yet reachable) fusion.
    expect(resolved?.targetNodeId).not.toBe(infraId('supabase-table', `${NODE_REF}/orders`))
    expect(resolved).toEqual({
      targetNodeId: infraId('supabase', NODE_REF),
      serviceName: NEAT_SERVICE,
      edgeType: EdgeType.CALLS,
    })
  })

  it('drops honestly when neither the sub-resource nor the project-level InfraNode exists — extraction never ran or found no createClient() call', () => {
    const graph = newGraph({ projectNode: false, tableNode: false })
    const resolveTarget = createSupabaseResolveTarget(graph, config())

    const resolved = resolveTarget(
      { targetKind: 'supabase-rpc', targetName: 'get_totals', callCount: 1, errorCount: 0, lastObservedIso: 'x' },
      baseCtx(),
    )

    expect(resolved).toBeNull()
  })

  it('returns null for a targetKind this connector does not own', () => {
    const graph = newGraph()
    const resolveTarget = createSupabaseResolveTarget(graph, config())

    const resolved = resolveTarget(
      { targetKind: 'unrelated-kind', targetName: 'x', callCount: 1, errorCount: 0, lastObservedIso: 'x' },
      baseCtx(),
    )

    expect(resolved).toBeNull()
  })
})

describe('Supabase connector — full pull/map/fuse via runConnectorPoll (docs/contracts/connectors.md §4)', () => {
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    realFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function stubLogsAll(): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(logsAllFixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch
  }

  it('treats an empty log window as a successful no-op, not a connector failure', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch
    const graph = newGraph({ projectNode: true, tableNode: true })
    const { connector, resolveTarget } = createSupabaseConnector(graph, config())

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    expect(result).toEqual({ signalCount: 0, edgesCreated: 0, edgesUpdated: 0, unresolved: 0 })
    expect(graph.size).toBe(0)
  })

  it('mints one project-level OBSERVED CALLS edge end to end, honestly landing at project grain since no .from()/.rpc() call site exists yet', async () => {
    stubLogsAll()
    const graph = newGraph({ projectNode: true, tableNode: false })
    const { connector, resolveTarget } = createSupabaseConnector(graph, config())

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    // 2 signals (orders table + get_totals rpc), both fall back to the same
    // project-level target — one edge created, one updated, none unresolved.
    expect(result).toEqual({ signalCount: 2, edgesCreated: 1, edgesUpdated: 1, unresolved: 0 })

    const edgeId = observedEdgeId(serviceId(NEAT_SERVICE), infraId('supabase', NODE_REF), EdgeType.CALLS)
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    // 2 calls from the orders signal + 1 from get_totals = 3 individual
    // upserts; only the one 500 counted as an error.
    expect(edge.signal?.spanCount).toBe(3)
    expect(edge.signal?.errorCount).toBe(1)
    // Landed on the ServiceNode directly, not a FileNode — no callSite ever
    // resolves for this connector's signals (no static .from()/.rpc() parser
    // exists yet), so there is no evidence.file to reconcile.
    expect(edge.evidence).toBeUndefined()
    expect(edge.source).toBe(serviceId(NEAT_SERVICE))
  })

  it('mints the sharper table-grain edge automatically once a future extractor creates the sub-resource InfraNode, no connector-side change', async () => {
    stubLogsAll()
    const graph = newGraph({ projectNode: true, tableNode: true })
    const { connector, resolveTarget } = createSupabaseConnector(graph, config())

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    expect(result.unresolved).toBe(0)
    expect(result.edgesCreated).toBe(2) // orders -> table node, get_totals -> project node (distinct targets now)

    const tableEdgeId = observedEdgeId(
      serviceId(NEAT_SERVICE),
      infraId('supabase-table', `${NODE_REF}/orders`),
      EdgeType.CALLS,
    )
    expect(graph.hasEdge(tableEdgeId)).toBe(true)
    const tableEdge = graph.getEdgeAttributes(tableEdgeId) as GraphEdge
    expect(tableEdge.signal?.spanCount).toBe(2)
    expect(tableEdge.signal?.errorCount).toBe(1)

    const projectEdgeId = observedEdgeId(serviceId(NEAT_SERVICE), infraId('supabase', NODE_REF), EdgeType.CALLS)
    expect(graph.hasEdge(projectEdgeId)).toBe(true)
  })

  it('drops every signal as unresolved when neither project-level nor sub-resource nodes exist — extraction never ran against this project', async () => {
    stubLogsAll()
    const graph = newGraph({ projectNode: false, tableNode: false })
    const { connector, resolveTarget } = createSupabaseConnector(graph, config())

    const result = await runConnectorPoll(connector, baseCtx(), graph, resolveTarget)

    expect(result).toEqual({ signalCount: 2, edgesCreated: 0, edgesUpdated: 0, unresolved: 2 })
  })

  it('combines both surfaces when a Postgres connection string is present, diffing pg_stat_statements alongside the log query', async () => {
    stubLogsAll()
    const graph = newGraph({ projectNode: true, tableNode: true })
    let pollCount = 0
    const fakeFetchStatements = async () => {
      pollCount += 1
      if (pollCount === 1) return STATEMENT_ROWS
      // Second poll: the orders statement ran 8 more times since baseline.
      return STATEMENT_ROWS.map((r) => (r.queryid === '1234567890123456789' ? { ...r, calls: '50' } : r))
    }
    const { connector, resolveTarget } = createSupabaseConnector(graph, config(), {
      fetchPgStatStatements: fakeFetchStatements,
    })
    const ctxWithPg = baseCtx({
      credentials: {
        managementToken: 'not-a-real-management-token',
        postgresConnectionString: 'postgres://neat_reader@db/postgres',
      },
    })

    // First poll: pg_stat_statements only establishes a baseline (no prior
    // poll to diff against) — only the 2 log-query signals resolve into
    // edges; nothing from surface 2 yet (map.ts's diffPgStatStatementsToSignals
    // doc comment).
    const first = await runConnectorPoll(connector, ctxWithPg, graph, resolveTarget)
    expect(first.signalCount).toBe(2)

    // Second poll, same connector instance (the statement baseline lives on
    // the instance, mirroring how startConnectorPollLoop reuses one connector
    // object across ticks): surface 2 now contributes a third signal, landing
    // on the same table-grain InfraNode the log-query surface's `orders`
    // signal already resolved to, aggregating onto the same edge.
    const second = await runConnectorPoll(connector, ctxWithPg, graph, resolveTarget)
    expect(second.signalCount).toBe(3)

    const tableEdgeId = observedEdgeId(
      serviceId(NEAT_SERVICE),
      infraId('supabase-table', `${NODE_REF}/orders`),
      EdgeType.CALLS,
    )
    const tableEdge = graph.getEdgeAttributes(tableEdgeId) as GraphEdge
    // 2 upserts (poll 1, log-query orders, 1 error) + 2 upserts (poll 2,
    // log-query orders again, 1 more error) + 8 upserts (poll 2,
    // pg_stat_statements delta, 0 errors) = 12 total on this one edge.
    expect(tableEdge.signal?.spanCount).toBe(12)
    expect(tableEdge.signal?.errorCount).toBe(2)
  })

  it('runs the pg_stat_statements surface only when credentials.postgresConnectionString is present', async () => {
    stubLogsAll()
    const graph = newGraph({ projectNode: true, tableNode: true })
    let called = false
    const fakeFetchStatements = async () => {
      called = true
      return STATEMENT_ROWS
    }
    const { connector, resolveTarget } = createSupabaseConnector(graph, config(), {
      fetchPgStatStatements: fakeFetchStatements,
    })

    await runConnectorPoll(connector, baseCtx(), graph, resolveTarget) // no postgresConnectionString
    expect(called).toBe(false)

    await runConnectorPoll(
      connector,
      baseCtx({
        credentials: {
          managementToken: 'not-a-real-management-token',
          postgresConnectionString: 'postgres://x',
        },
      }),
      graph,
      resolveTarget,
    )
    expect(called).toBe(true)
  })

  it('bounds the log query window to the provider\'s 24h cap when since is absent or older, passing it straight through when it is recent', async () => {
    let capturedUrl: URL | undefined
    globalThis.fetch = (async (input: string | URL) => {
      capturedUrl = new URL(input as string | URL)
      return new Response(JSON.stringify({ result: [] }), { status: 200 })
    }) as typeof globalThis.fetch

    const graph = newGraph()
    const { connector, resolveTarget } = createSupabaseConnector(graph, config())

    const now = Date.now()
    await runConnectorPoll(connector, baseCtx(), graph, resolveTarget) // no `since` at all
    const noSinceStart = new Date(capturedUrl!.searchParams.get('iso_timestamp_start')!).getTime()
    expect(now - noSinceStart).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000)
    expect(now - noSinceStart).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000)

    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString()
    await runConnectorPoll(connector, baseCtx({ since: tenDaysAgo }), graph, resolveTarget)
    const oldSinceStart = new Date(capturedUrl!.searchParams.get('iso_timestamp_start')!).getTime()
    // Truncated to the 24h floor, not the real (10-day-old) `since`.
    expect(now - oldSinceStart).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000)

    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
    await runConnectorPoll(connector, baseCtx({ since: oneHourAgo }), graph, resolveTarget)
    expect(capturedUrl!.searchParams.get('iso_timestamp_start')).toBe(oneHourAgo)
  })

  it('requires ctx.credentials.managementToken and never lets it reach a graph mutation', async () => {
    const connector = new SupabaseConnector(config())

    await expect(connector.poll({ projectDir: '/repo', credentials: {} })).rejects.toThrow(/managementToken/)
  })

  it('rejects a bad Management API token cleanly without echoing the token or provider body', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"raw provider body containing select * from edge_logs"}', {
        status: 401,
        statusText: 'Unauthorized',
      })) as typeof fetch

    let thrown: Error | undefined
    try {
      await fetchSupabaseEdgeLogs(
        config(),
        'not-a-real-management-token-that-must-not-print',
        '2026-07-03T10:00:00.000Z',
        '2026-07-03T10:05:00.000Z',
        fetchImpl,
      )
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown?.message).toMatch(/request rejected \(HTTP 401\)/)
    expect(thrown?.message).toContain('Management API token')
    expect(thrown?.message).not.toContain('not-a-real-management-token-that-must-not-print')
    expect(thrown?.message).not.toContain('select * from edge_logs')
  })

  it('surfaces Supabase log-query throttling as a retry-later condition', async () => {
    const fetchImpl = (async () =>
      new Response('too many requests', {
        status: 429,
        statusText: 'Too Many Requests',
      })) as typeof fetch

    await expect(
      fetchSupabaseEdgeLogs(
        config(),
        'not-a-real-management-token',
        '2026-07-03T10:00:00.000Z',
        '2026-07-03T10:05:00.000Z',
        fetchImpl,
      ),
    ).rejects.toThrow(/rate-limited \(HTTP 429\).*next poll/)
  })

  it('redacts logs.all provider errors instead of echoing SQL or raw diagnostic text', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'Syntax error near select * from edge_logs where token = not-a-real-management-token',
            errors: [],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch

    let thrown: Error | undefined
    try {
      await fetchSupabaseEdgeLogs(
        config(),
        'not-a-real-management-token',
        '2026-07-03T10:00:00.000Z',
        '2026-07-03T10:05:00.000Z',
        fetchImpl,
      )
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown?.message).toContain('provider error (code 400, status INVALID_ARGUMENT)')
    expect(thrown?.message).toContain('provider message redacted')
    expect(thrown?.message).not.toContain('select *')
    expect(thrown?.message).not.toContain('not-a-real-management-token')
  })

  it('degrades pg_stat_statements failures to a warning while preserving the Management API log surface', async () => {
    stubLogsAll()
    const graph = newGraph({ projectNode: true, tableNode: false })
    const summaries: string[] = []
    const fakeFetchStatements = async () => {
      throw Object.assign(new Error('permission denied for relation pg_stat_statements on postgres://secret'), {
        code: '42501',
      })
    }
    const { connector, resolveTarget } = createSupabaseConnector(graph, config(), {
      fetchPgStatStatements: fakeFetchStatements,
      onPostgresSurfaceError: (_err, summary) => summaries.push(summary),
    })

    const result = await runConnectorPoll(
      connector,
      baseCtx({
        credentials: {
          managementToken: 'not-a-real-management-token',
          postgresConnectionString: 'postgres://neat_reader:secret@db/postgres',
        },
      }),
      graph,
      resolveTarget,
    )

    expect(result).toEqual({ signalCount: 2, edgesCreated: 1, edgesUpdated: 1, unresolved: 0 })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('pg_read_all_stats')
    expect(summaries[0]).toContain('continuing with Management API log surface')
    expect(summaries[0]).not.toContain('postgres://secret')
    expect(summaries[0]).not.toContain('neat_reader:secret')
  })

  it('names a missing pg_stat_statements extension or view without leaking the raw Postgres error', () => {
    const summary = describeSupabasePostgresSurfaceFailure(
      API_PROJECT_REF,
      Object.assign(new Error('relation "pg_stat_statements" does not exist on postgres://secret'), {
        code: '42P01',
      }),
    )

    expect(summary).toContain('pg_stat_statements is not enabled or visible')
    expect(summary).toContain('continuing with Management API log surface')
    expect(summary).not.toContain('postgres://secret')
    expect(summary).not.toContain('relation "pg_stat_statements" does not exist')
  })
})

describe('Supabase connector — scope guard (docs/connectors/supabase.md §Out of scope)', () => {
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const dir = path.resolve(__dirname, '../src/connectors/supabase')

  it('never queries storage_logs / auth_logs / function_*_logs / realtime_logs — out of scope for this cut', () => {
    const offenders: string[] = []
    const scopeCreepPattern = /storage_logs|auth_logs|function_edge_logs|function_logs|realtime_logs/i
    for (const file of walk(dir)) {
      if (scopeCreepPattern.test(readFileSync(file, 'utf8'))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('never issues a write statement against the polled Postgres database', () => {
    const offenders: string[] = []
    const writePattern = /\b(insert into|update\s+\S+\s+set|delete from|drop table|truncate|alter table)\b/i
    for (const file of walk(dir)) {
      if (writePattern.test(readFileSync(file, 'utf8'))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

describe('Supabase connector — contracts.md §6 (credentials never reach a graph mutation call)', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const dir = path.resolve(__dirname, '../src/connectors/supabase')

  function walk(dirPath: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dirPath)) {
      const full = path.join(dirPath, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('no line in connectors/supabase/** mentions credentials alongside a graph mutator', () => {
    const mutators =
      /\b(graph|g)\.(addNode|addEdge|addEdgeWithKey|addDirectedEdge|addDirectedEdgeWithKey|replaceNodeAttributes|replaceEdgeAttributes|mergeNodeAttributes|mergeEdgeAttributes)\s*\(/
    const offenders: string[] = []
    for (const file of walk(dir)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/credentials/.test(line) && mutators.test(line)) offenders.push(`${file}:${i + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('connectors/supabase/** never mutates the graph directly (ADR-030) — only reads via forEachNode/hasNode', () => {
    const mutators =
      /\b(graph|g)\.(addNode|addEdge|addEdgeWithKey|addDirectedEdge|addDirectedEdgeWithKey|dropNode|dropEdge|replaceNodeAttributes|replaceEdgeAttributes|mergeNodeAttributes|mergeEdgeAttributes)\s*\(/
    for (const file of walk(dir)) {
      expect(mutators.test(readFileSync(file, 'utf8')), file).toBe(false)
    }
  })
})
