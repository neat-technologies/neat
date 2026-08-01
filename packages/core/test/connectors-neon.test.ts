import { describe, expect, it } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  fileId,
  infraId,
  observedEdgeId,
  serviceId,
  type FileNode,
  type GraphEdge,
  type GraphNode,
  type InfraNode,
  type ServiceNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { runConnectorPoll } from '../src/connectors/index.js'
import {
  NeonConnector,
  createNeonResolveTarget,
  diffNeonStatementsToSignals,
  fetchNeonStatements,
  type NeonPgClientLike,
  type NeonStatementRow,
} from '../src/connectors/neon/index.js'

describe('Neon pg_stat_statements client', () => {
  it('uses a read-only session and a bounded statement query through the DB junction', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = []
    let ended = false
    const client: NeonPgClientLike = {
      async connect() {},
      async query<T>(text: string, values?: unknown[]) {
        calls.push({ text, values })
        return { rows: [{ queryid: '1', query: 'select * from orders', calls: '7' }] as T[] }
      },
      async end() {
        ended = true
      },
    }

    const rows = await fetchNeonStatements(
      'postgresql://scoped@neon/db',
      'project-1',
      25,
      () => client,
    )

    expect(rows).toHaveLength(1)
    expect(calls[0]?.text).toBe('SET default_transaction_read_only = on')
    expect(calls[1]?.text).toContain('from pg_stat_statements')
    expect(calls[1]?.values).toEqual([25])
    expect(ended).toBe(true)
  })
})

describe('Neon statement mapping', () => {
  it('baselines cumulative counters, emits positive deltas, and rejects ambiguous SQL', () => {
    const baselines = new Map()
    const first: NeonStatementRow[] = [
      { queryid: 'orders', query: 'SELECT * FROM "public"."orders"', calls: '10' },
      { queryid: 'joined', query: 'SELECT * FROM orders JOIN customers USING (id)', calls: '4' },
    ]
    expect(diffNeonStatementsToSignals(first, baselines, '2026-07-31T12:00:00.000Z')).toEqual([])

    const second: NeonStatementRow[] = [
      { queryid: 'orders', query: 'SELECT * FROM "public"."orders"', calls: '13' },
      { queryid: 'joined', query: 'SELECT * FROM orders JOIN customers USING (id)', calls: '8' },
    ]
    expect(diffNeonStatementsToSignals(second, baselines, '2026-07-31T12:01:00.000Z')).toEqual([
      {
        targetKind: 'sql-table',
        targetName: 'orders',
        callCount: 3,
        errorCount: 0,
        lastObservedIso: '2026-07-31T12:01:00.000Z',
      },
    ])

    expect(
      diffNeonStatementsToSignals(
        [{ queryid: 'orders', query: 'SELECT * FROM orders', calls: '1' }],
        baselines,
        '2026-07-31T12:02:00.000Z',
      ),
    ).toEqual([])
  })
})

describe('Neon exact SQL-table fusion', () => {
  it('lands OBSERVED on the same infraId and uniquely-attributed file as EXTRACTED', async () => {
    const graph = new MultiDirectedGraph<GraphNode, GraphEdge>({
      allowSelfLoops: false,
    }) as NeatGraph
    const service: ServiceNode = {
      id: serviceId('orders-api'),
      type: NodeType.ServiceNode,
      name: 'orders-api',
      language: 'python',
    }
    const file: FileNode = {
      id: fileId('orders-api', 'models.py'),
      type: NodeType.FileNode,
      service: 'orders-api',
      path: 'models.py',
      language: 'python',
    }
    const table: InfraNode = {
      id: infraId('sql-table', 'orders'),
      type: NodeType.InfraNode,
      name: 'orders',
      provider: 'self',
      kind: 'sql-table',
    }
    graph.addNode(service.id, service)
    graph.addNode(file.id, file)
    graph.addNode(table.id, table)
    const extractedId = extractedEdgeId(file.id, table.id, EdgeType.CALLS)
    const extracted: GraphEdge = {
      id: extractedId,
      source: file.id,
      target: table.id,
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
      confidence: 0.85,
      evidence: { file: 'models.py', line: 7 },
    }
    graph.addEdgeWithKey(extracted.id, extracted.source, extracted.target, extracted)

    let poll = 0
    const rows: NeonStatementRow[][] = [
      [{ queryid: '1', query: 'SELECT * FROM orders', calls: '20' }],
      [{ queryid: '1', query: 'SELECT * FROM orders', calls: '22' }],
    ]
    const connector = new NeonConnector(
      { projectId: 'neon-project', serviceName: 'orders-api' },
      {
        fetchStatements: async () => rows[poll++]!,
        now: () => new Date('2026-07-31T12:01:00.000Z'),
      },
    )
    const ctx = {
      projectDir: '/repo',
      credentials: { connectionString: 'postgresql://scoped@neon/db' },
    }
    const resolve = createNeonResolveTarget({
      projectId: 'neon-project',
      serviceName: 'orders-api',
    })

    expect(await runConnectorPoll(connector, ctx, graph, resolve)).toMatchObject({ signalCount: 0 })
    expect(await runConnectorPoll(connector, ctx, graph, resolve)).toEqual({
      signalCount: 1,
      edgesCreated: 1,
      edgesUpdated: 0,
      unresolved: 0,
    })

    const canonicalTableId = infraId('sql-table', 'orders')
    expect(canonicalTableId).toBe(table.id)
    expect(graph.hasEdge(extractedId)).toBe(true)
    const observedId = observedEdgeId(file.id, canonicalTableId, EdgeType.CALLS)
    expect(graph.hasEdge(observedId)).toBe(true)
    expect(graph.getEdgeAttribute(observedId, 'provenance')).toBe(Provenance.OBSERVED)
    expect(graph.getEdgeAttribute(observedId, 'signal')?.spanCount).toBe(2)
  })
})

describe('Neon column-grain fusion (ADR-157)', () => {
  it('carries the parsed columns on a pg_stat_statements signal (shared parser)', () => {
    const baselines = new Map()
    const q = 'SELECT "id", "amount" FROM "public"."orders" WHERE "id" = $1'
    diffNeonStatementsToSignals([{ queryid: 'q', query: q, calls: '10' }], baselines, 't0')
    const signals = diffNeonStatementsToSignals(
      [{ queryid: 'q', query: q, calls: '13' }],
      baselines,
      't1',
    )
    expect(signals).toHaveLength(1)
    expect(signals[0]!.columns?.slice().sort()).toEqual(['amount', 'id'])
  })

  it('lands OBSERVED columns on the sql-table node through runConnectorPoll', async () => {
    const graph = new MultiDirectedGraph<GraphNode, GraphEdge>({
      allowSelfLoops: false,
    }) as NeatGraph

    let poll = 0
    const q = 'SELECT "id", "amount" FROM "public"."orders" WHERE "id" = $1'
    const rows: NeonStatementRow[][] = [
      [{ queryid: '1', query: q, calls: '20' }],
      [{ queryid: '1', query: q, calls: '22' }],
    ]
    const connector = new NeonConnector(
      { projectId: 'neon-project', serviceName: 'orders-api' },
      { fetchStatements: async () => rows[poll++]!, now: () => new Date('2026-07-31T12:01:00.000Z') },
    )
    const ctx = {
      projectDir: '/repo',
      credentials: { connectionString: 'postgresql://scoped@neon/db' },
    }
    const resolve = createNeonResolveTarget({ projectId: 'neon-project', serviceName: 'orders-api' })

    await runConnectorPoll(connector, ctx, graph, resolve) // baseline
    await runConnectorPoll(connector, ctx, graph, resolve) // delta → mint + merge

    const tableId = infraId('sql-table', 'orders')
    expect(graph.hasNode(tableId)).toBe(true)
    const node = graph.getNodeAttributes(tableId) as InfraNode
    const columns = (node.columns ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
    expect(columns.map((c) => c.name)).toEqual(['amount', 'id'])
    expect(columns.every((c) => c.provenances.includes(Provenance.OBSERVED))).toBe(true)
  })
})
