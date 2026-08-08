import { describe, expect, it } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  infraId,
  type GraphEdge,
  type GraphNode,
  type InfraNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import type { ConnectorContext } from '../src/connectors/types.js'
import {
  PlanetscaleConnector,
  createPlanetscaleResolveTarget,
  mapInsightsToSignals,
  type PlanetscaleConnectorConfig,
  type PlanetscaleInsightRow,
} from '../src/connectors/planetscale/index.js'

const CONFIG: PlanetscaleConnectorConfig = {
  organization: 'acme',
  database: 'shop',
  branch: 'main',
  serviceName: 'orders-api',
}

const CREDS = { serviceTokenId: 'tid', serviceToken: 'tok' }

describe('PlanetScale Insights mapping', () => {
  it('emits one signal per table a fingerprint touched (multi-table fans out)', () => {
    const rows: PlanetscaleInsightRow[] = [
      { tables: ['orders', 'customers'], query_count: 5, error_count: 1, last_run_at: '2026-08-09T10:00:00.000Z' },
    ]
    expect(mapInsightsToSignals(rows, '2026-08-09T11:00:00.000Z')).toEqual([
      { targetKind: 'sql-table', targetName: 'orders', callCount: 5, errorCount: 1, lastObservedIso: '2026-08-09T10:00:00.000Z' },
      { targetKind: 'sql-table', targetName: 'customers', callCount: 5, errorCount: 1, lastObservedIso: '2026-08-09T10:00:00.000Z' },
    ])
  })

  it('falls back to qualified_tables when tables is empty, and to the poll time when last_run_at is absent', () => {
    const rows: PlanetscaleInsightRow[] = [
      { tables: [], qualified_tables: ['shop.orders'], query_count: 2 },
    ]
    expect(mapInsightsToSignals(rows, '2026-08-09T11:00:00.000Z')).toEqual([
      { targetKind: 'sql-table', targetName: 'shop.orders', callCount: 2, errorCount: 0, lastObservedIso: '2026-08-09T11:00:00.000Z' },
    ])
  })

  it('drops a row with no positive query_count rather than minting a phantom edge', () => {
    const rows: PlanetscaleInsightRow[] = [
      { tables: ['orders'], query_count: 0 },
      { tables: ['orders'], query_count: undefined },
      { tables: ['orders'] },
    ]
    expect(mapInsightsToSignals(rows, '2026-08-09T11:00:00.000Z')).toEqual([])
  })
})

function graphWithTable(tableName: string): NeatGraph {
  const graph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
  const table: InfraNode = {
    id: infraId('sql-table', tableName),
    type: NodeType.InfraNode,
    name: tableName,
    provider: 'self',
    kind: 'sql-table',
  }
  graph.addNode(table.id, table)
  return graph
}

const CTX: ConnectorContext = { projectDir: '/x', credentials: CREDS }

describe('PlanetScale target resolution', () => {
  it('resolves onto the existing sql-table node the extractor already minted', () => {
    const resolve = createPlanetscaleResolveTarget(graphWithTable('orders'), CONFIG)
    const resolved = resolve(
      { targetKind: 'sql-table', targetName: 'orders', callCount: 3, errorCount: 0, lastObservedIso: '2026-08-09T11:00:00.000Z' },
      CTX,
    )
    expect(resolved).toEqual({
      targetNodeId: infraId('sql-table', 'orders'),
      serviceName: 'orders-api',
      edgeType: EdgeType.CALLS,
    })
  })

  it('honest miss: no sql-table node → the provider-level planetscale-database node, never a fabricated table', () => {
    const resolve = createPlanetscaleResolveTarget(graphWithTable('orders'), CONFIG)
    const resolved = resolve(
      { targetKind: 'sql-table', targetName: 'unextracted', callCount: 1, errorCount: 0, lastObservedIso: '2026-08-09T11:00:00.000Z' },
      CTX,
    )
    expect(resolved?.targetNodeId).toBe(infraId('planetscale-database', 'acme/shop'))
    expect(resolved?.edgeType).toBe(EdgeType.CALLS)
    expect(resolved?.ensureInfraNode).toEqual({ kind: 'planetscale-database', name: 'acme/shop', provider: 'planetscale' })
  })

  it('ignores a signal that is not a sql-table target', () => {
    const resolve = createPlanetscaleResolveTarget(graphWithTable('orders'), CONFIG)
    expect(resolve({ targetKind: 'route', targetName: '/x', callCount: 1, errorCount: 0, lastObservedIso: '2026-08-09T11:00:00.000Z' }, CTX)).toBeNull()
  })
})

describe('PlanetScale connector poll', () => {
  it('reads the insights window with the id:token header and maps the page to signals', async () => {
    const seen: { url: string; auth?: string } = { url: '' }
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.url = String(input)
      seen.auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      const body = { data: [{ tables: ['orders'], query_count: 4, error_count: 0, last_run_at: '2026-08-09T10:30:00.000Z' }], next_page: null }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const connector = new PlanetscaleConnector(CONFIG, { fetchImpl, now: () => new Date('2026-08-09T11:00:00.000Z') })
    const signals = await connector.poll({ projectDir: '/x', credentials: CREDS, since: '2026-08-09T10:00:00.000Z' })

    expect(signals).toEqual([
      { targetKind: 'sql-table', targetName: 'orders', callCount: 4, errorCount: 0, lastObservedIso: '2026-08-09T10:30:00.000Z' },
    ])
    expect(seen.url).toContain('/organizations/acme/databases/shop/branches/main/insights')
    expect(seen.url).toContain('from=2026-08-09T10%3A00%3A00.000Z')
    expect(seen.auth).toBe('tid:tok')
  })
})
