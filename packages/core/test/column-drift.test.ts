import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph, type NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { computeDivergences } from '../src/divergences.js'
import { tableFromSqlStatement, columnsFromSqlStatement, type ParsedSpan } from '../src/otel.js'
import { NodeType, Provenance, type InfraNode } from '@neat.is/types'

// ADR-157 §4 — column-drift. A declared-only column is `missing-observed`, an
// observed-only column is `missing-extracted`, at column grain; a column on BOTH
// sides is fused, not drift. Two shapes: a seeded node (the model) and the live
// hero (a real Drizzle schema + the SQL its queries generate, through extract +
// ingest).

const colDrifts = (g: NeatGraph) =>
  computeDivergences(g).divergences.filter((d) => 'column' in d && d.column)

describe('column-drift divergence (seeded node, new provenance model)', () => {
  beforeEach(() => resetGraph())

  function seedTable(columns: InfraNode['columns']): NeatGraph {
    const g = getGraph()
    g.addNode('infra:sql-table:orders', {
      id: 'infra:sql-table:orders',
      type: NodeType.InfraNode,
      name: 'orders',
      provider: 'self',
      kind: 'sql-table',
      columns,
    })
    return g
  }

  it('flags declared-only + observed-only, but not a column present on both sides', () => {
    const g = seedTable([
      // `id` is BOTH declared and observed — one entry, both provenances.
      { name: 'id', provenances: [Provenance.EXTRACTED, Provenance.OBSERVED], confidence: 0.9 },
      { name: 'total', provenances: [Provenance.EXTRACTED], confidence: 0.85 },
      { name: 'amount', provenances: [Provenance.OBSERVED], confidence: 0.9 },
    ])
    const cols = colDrifts(g)
    const total = cols.find((d) => d.column === 'total')
    const amount = cols.find((d) => d.column === 'amount')
    expect(total?.type).toBe('missing-observed')
    expect(total?.table).toBe('infra:sql-table:orders')
    expect(amount?.type).toBe('missing-extracted')
    expect(amount?.table).toBe('infra:sql-table:orders')
    // `id` agrees on both sides — no drift (the provenance-model change is what
    // lets one entry carry both, so it reads as fused rather than clobbered).
    expect(cols.find((d) => d.column === 'id')).toBeUndefined()
  })

  it('emits nothing when only one side is present anywhere on the table', () => {
    const declaredOnly = seedTable([
      { name: 'total', provenances: [Provenance.EXTRACTED], confidence: 0.85 },
    ])
    expect(colDrifts(declaredOnly)).toHaveLength(0)

    resetGraph()
    const observedOnly = seedTable([
      { name: 'amount', provenances: [Provenance.OBSERVED], confidence: 0.9 },
    ])
    expect(colDrifts(observedOnly)).toHaveLength(0)
  })
})

describe('column-drift divergence (live hero: Drizzle total → observed amount)', () => {
  let dir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetGraph()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-coldrift-'))
    ctx = { graph: getGraph(), errorsPath: path.join(dir, 'errors.ndjson'), scanPath: dir }
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function writeDrizzleService(): Promise<void> {
    const svc = path.join(dir, 'api')
    await fs.mkdir(path.join(svc, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(svc, 'package.json'),
      JSON.stringify({ name: 'orders', version: '1.0.0', dependencies: { 'drizzle-orm': '0.30.0' } }),
    )
    // The schema still declares `total` — a migration renamed it to `amount` in
    // the database, but this writer was never updated. `userId` is declared as
    // the DB column `user_id`: it must fuse with the observed `user_id`, no drift.
    await fs.writeFile(
      path.join(svc, 'src', 'schema.ts'),
      `import { pgTable, serial, integer, text, timestamp } from 'drizzle-orm/pg-core'
       export const orders = pgTable('orders', {
         id: serial('id').primaryKey(),
         userId: integer('user_id'),
         total: integer('total'),
         status: text('status'),
         createdAt: timestamp('created_at'),
       })
      `,
    )
  }

  function sqlSpan(statement: string): ParsedSpan {
    return {
      service: 'orders',
      traceId: 't1',
      spanId: Math.random().toString(36).slice(2),
      name: 'pg.query',
      kind: 3,
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      env: 'production',
      attributes: { 'db.system': 'postgresql', 'db.statement': statement },
      dbSystem: 'postgresql',
      dbTable: tableFromSqlStatement(statement) ?? undefined,
      dbColumns: columnsFromSqlStatement(statement) ?? undefined,
      statusCode: 0,
    }
  }

  it('fuses declared + observed on one node; field-rename drifts, userId→user_id does not', async () => {
    await writeDrizzleService()
    await extractFromDirectory(ctx.graph, dir)

    // Production runs the renamed schema: it writes `amount` (new) and touches
    // every declared column except `total` (gone). `user_id` appears on both
    // sides — the fusion-key case.
    await handleSpan(ctx, sqlSpan('INSERT INTO orders (user_id, amount, status) VALUES ($1, $2, $3)'))
    await handleSpan(
      ctx,
      sqlSpan('SELECT id, user_id, amount, status, created_at FROM orders WHERE user_id = $1'),
    )

    const node = ctx.graph.getNodeAttributes('infra:sql-table:orders') as InfraNode
    const provOf = (name: string): Set<string> => {
      const col = (node.columns ?? []).find((c) => c.name === name)
      return new Set(col?.provenances ?? [])
    }
    // The declared-only, observed-only, and both-sides columns each read cleanly.
    expect(provOf('total')).toEqual(new Set([Provenance.EXTRACTED]))
    expect(provOf('amount')).toEqual(new Set([Provenance.OBSERVED]))
    expect(provOf('user_id')).toEqual(new Set([Provenance.EXTRACTED, Provenance.OBSERVED]))
    // The camelCase field never leaked in — fusion is on the DB name.
    expect((node.columns ?? []).some((c) => c.name === 'userid')).toBe(false)

    const cols = colDrifts(ctx.graph)
    const total = cols.find((d) => d.column === 'total')
    const amount = cols.find((d) => d.column === 'amount')
    expect(total?.type).toBe('missing-observed')
    expect(total?.reason).toContain('orders.total')
    expect(amount?.type).toBe('missing-extracted')
    expect(amount?.reason).toContain('orders.amount')
    // Every column code and production agree on — including the userId→user_id
    // fusion — does NOT drift.
    for (const shared of ['id', 'user_id', 'status', 'created_at']) {
      expect(cols.find((d) => d.column === shared)).toBeUndefined()
    }
    // Exactly the two real drifts, no phantoms.
    expect(cols).toHaveLength(2)
  })
})
