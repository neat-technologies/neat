import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { computeDivergences } from '../src/divergences.js'
import { EdgeType, Provenance, type GraphEdge } from '@neat.is/types'
import type { ParsedSpan } from '../src/otel.js'

// ADR-141 — an ORM (Prisma) declares its DB via env("DATABASE_URL") and emits
// host-less db.system spans. These tests pin the three coordinated pieces
// against a REAL extracted graph, and — the point of the after-the-fact audit —
// exercise the cases that were only reasoned about before: the ambiguous
// fallback and that a genuinely-unused DB still diverges (no over-suppression).

async function writePrismaService(
  dir: string,
  opts: { url?: string; env?: Record<string, string>; extraEnvKeys?: Record<string, string> } = {},
): Promise<void> {
  const svc = path.join(dir, 'api')
  await fs.mkdir(path.join(svc, 'prisma'), { recursive: true })
  await fs.writeFile(
    path.join(svc, 'package.json'),
    JSON.stringify({ name: 'orders', version: '1.0.0', dependencies: { '@prisma/client': '6.0.0' } }),
  )
  const url = opts.url ?? 'env("DATABASE_URL")'
  await fs.writeFile(
    path.join(svc, 'prisma', 'schema.prisma'),
    `generator client { provider = "prisma-client-js" }\ndatasource db {\n  provider = "postgresql"\n  url = ${url}\n}\n`,
  )
  const env = opts.env ?? { DATABASE_URL: 'postgres://u:p@db.prod.example.com:5432/orders' }
  const lines = Object.entries({ ...env, ...(opts.extraEnvKeys ?? {}) }).map(([k, v]) => `${k}=${v}`)
  await fs.writeFile(path.join(svc, '.env'), lines.join('\n') + '\n')
}

async function writeConfigService(
  dir: string,
  configName: string,
  configBody: string,
): Promise<void> {
  const svc = path.join(dir, 'api')
  await fs.mkdir(svc, { recursive: true })
  await fs.writeFile(
    path.join(svc, 'package.json'),
    JSON.stringify({ name: 'orders', version: '1.0.0' }),
  )
  await fs.writeFile(path.join(svc, configName), configBody)
  await fs.writeFile(path.join(svc, '.env'), 'DATABASE_URL=postgres://u:p@db.prod.example.com:5432/orders\n')
}

function hostlessPgSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
  // A Prisma engine db_query span: db.system present, NO server.address.
  return {
    service: 'orders',
    traceId: 't1',
    spanId: 's1',
    name: 'prisma:engine:db_query',
    kind: 3,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: { 'db.system': 'postgresql' },
    dbSystem: 'postgresql',
    statusCode: 0,
    ...overrides,
  }
}

function dbNodes(): string[] {
  const g = getGraph()
  return g.filterNodes((id) => id.startsWith('database:'))
}

describe('ORM host-less DB fusion (ADR-141)', () => {
  let dir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetGraph()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-orm-fusion-'))
    ctx = { graph: getGraph(), errorsPath: path.join(dir, 'errors.ndjson'), scanPath: dir }
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('resolves Prisma env("DATABASE_URL") to the real host — one DB node, not a placeholder', async () => {
    await writePrismaService(dir)
    await extractFromDirectory(ctx.graph, dir)
    const dbs = dbNodes()
    expect(dbs).toEqual(['database:db.prod.example.com'])
    expect(dbs).not.toContain('database:postgresql-prisma')
  })

  it('fuses a host-less db.system span onto the declared DB, and the divergence clears', async () => {
    await writePrismaService(dir)
    await extractFromDirectory(ctx.graph, dir)
    await handleSpan(ctx, hostlessPgSpan())

    // The OBSERVED CONNECTS_TO landed on the DECLARED node, not a fresh local one.
    const observedToDeclared = ctx.graph
      .filterEdges((_id, e: GraphEdge) => e.provenance === Provenance.OBSERVED && e.type === EdgeType.CONNECTS_TO)
      .map((id) => ctx.graph.getEdgeAttributes(id) as GraphEdge)
    expect(observedToDeclared.map((e) => e.target)).toContain('database:db.prod.example.com')
    // No service-local node minted (that would be the un-fused fallback).
    expect(dbNodes().filter((id) => id.includes('/postgresql'))).toHaveLength(0)

    // The declared DB no longer diverges — declared and observed compare at
    // service grain, so no missing-observed AND no missing-extracted for it.
    const { divergences } = computeDivergences(ctx.graph)
    expect(divergences.filter((d) => d.target === 'database:db.prod.example.com')).toHaveLength(0)
  })

  it('AUDIT: falls back to a service-local node when the service declares TWO same-engine DBs', async () => {
    // Two postgres connection strings → two declared DB nodes → ambiguous.
    await writePrismaService(dir, {
      env: {
        DATABASE_URL: 'postgres://u:p@db-a.example.com:5432/orders',
        POSTGRES_URL: 'postgres://u:p@db-b.example.com:5432/orders',
      },
    })
    await extractFromDirectory(ctx.graph, dir)
    expect(dbNodes().length).toBeGreaterThanOrEqual(2)

    await handleSpan(ctx, hostlessPgSpan())
    // Ambiguous → the fusion must NOT guess; it mints the service-local node.
    expect(dbNodes().some((id) => id.includes('/postgresql'))).toBe(true)
  })

  it('AUDIT: a genuinely-unused declared DB STILL surfaces as missing-observed (no over-suppression)', async () => {
    await writePrismaService(dir)
    await extractFromDirectory(ctx.graph, dir)
    // No span driven — nothing observed. The roll-up must not hide the gap.
    const { divergences } = computeDivergences(ctx.graph)
    const miss = divergences.find(
      (d) => d.type === 'missing-observed' && d.target === 'database:db.prod.example.com',
    )
    expect(miss, 'an unused declared DB must still diverge').toBeDefined()
  })

  it('resolves a Drizzle `url: process.env.X` to the real host — one DB node, not a placeholder (#807)', async () => {
    await writeConfigService(
      dir,
      'drizzle.config.ts',
      'export default { dialect: "postgresql", dbCredentials: { url: process.env.DATABASE_URL! } }\n',
    )
    await extractFromDirectory(ctx.graph, dir)
    expect(dbNodes()).toEqual(['database:db.prod.example.com'])
    expect(dbNodes()).not.toContain('database:postgresql-drizzle')
  })

  it('resolves a Knex `connection: process.env.X` to the real host — one DB node, not a placeholder (#807)', async () => {
    await writeConfigService(
      dir,
      'knexfile.js',
      "module.exports = { client: 'pg', connection: process.env.DATABASE_URL }\n",
    )
    await extractFromDirectory(ctx.graph, dir)
    expect(dbNodes()).toEqual(['database:db.prod.example.com'])
    expect(dbNodes()).not.toContain('database:postgresql-knex')
  })
})
