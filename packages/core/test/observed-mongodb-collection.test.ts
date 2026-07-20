import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { EdgeType, Provenance, infraId, type GraphEdge } from '@neat.is/types'
import type { ParsedSpan } from '../src/otel.js'

// ADR-148 — the MongoDB per-collection OBSERVED signal is the `db.collection`
// attribute on the mongodb spans NEAT already ingests, read into a
// collection-grained edge that fuses onto the extractor's static twin (ADR-147).

const ORDERS_COLLECTION = infraId('mongodb-collection', 'orders')

function mongoSpan(overrides: Partial<ParsedSpan> = {}): ParsedSpan {
  return {
    service: 'orders',
    traceId: 't1',
    spanId: 's1',
    name: 'mongodb.find',
    kind: 3, // CLIENT
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: { 'db.system': 'mongodb', 'db.collection.name': 'orders' },
    dbSystem: 'mongodb',
    dbCollection: 'orders',
    statusCode: 0,
    ...overrides,
  }
}

async function writeMongooseService(dir: string): Promise<void> {
  const svc = path.join(dir, 'api')
  await fs.mkdir(svc, { recursive: true })
  await fs.writeFile(
    path.join(svc, 'package.json'),
    JSON.stringify({ name: 'orders', version: '1.0.0', dependencies: { mongoose: '^8.0.0' } }),
  )
  await fs.writeFile(
    path.join(svc, 'models.js'),
    `const mongoose = require('mongoose')\n` +
      `const Order = mongoose.model('Order', new mongoose.Schema({ name: String }))\n` +
      `module.exports = { Order }\n`,
  )
}

function collectionNodes(g = getGraph()): string[] {
  return g.filterNodes((id) => id.startsWith('infra:mongodb-collection:'))
}
function observedCallTargets(ctx: IngestContext): string[] {
  return ctx.graph
    .filterEdges((_id, e: GraphEdge) => e.provenance === Provenance.OBSERVED && e.type === EdgeType.CALLS)
    .map((id) => (ctx.graph.getEdgeAttributes(id) as GraphEdge).target)
}

describe('MongoDB collection OBSERVED from driver spans (ADR-148)', () => {
  let dir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetGraph()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-mongo-observed-'))
    ctx = { graph: getGraph(), errorsPath: path.join(dir, 'errors.ndjson'), scanPath: dir }
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('mints an OBSERVED CALLS edge to the collection node from a mongodb span', async () => {
    await handleSpan(ctx, mongoSpan())
    expect(collectionNodes()).toEqual([ORDERS_COLLECTION])
    expect(observedCallTargets(ctx)).toContain(ORDERS_COLLECTION)
  })

  it('reads the collection from the older db.mongodb.collection key too', async () => {
    // (The attribute-key fallback lives in otel.ts; here the ParsedSpan is built
    // directly, so we assert the ingest still mints from dbCollection whatever
    // key populated it.)
    await handleSpan(ctx, mongoSpan({ attributes: { 'db.system': 'mongodb', 'db.mongodb.collection': 'orders' } }))
    expect(observedCallTargets(ctx)).toContain(ORDERS_COLLECTION)
  })

  it('is additive — a mongodb span with no collection mints no collection node', async () => {
    await handleSpan(ctx, mongoSpan({ attributes: { 'db.system': 'mongodb' }, dbCollection: undefined }))
    expect(collectionNodes()).toEqual([])
  })

  it('does not mint a collection edge for a non-mongodb db span', async () => {
    await handleSpan(ctx, mongoSpan({ dbSystem: 'postgresql', dbCollection: undefined, attributes: { 'db.system': 'postgresql' } }))
    expect(collectionNodes()).toEqual([])
  })

  it('fuses onto the extractor’s static twin — one collection node, both provenances land on it', async () => {
    await writeMongooseService(dir)
    await extractFromDirectory(ctx.graph, dir)

    // The extractor named the collection statically (Order → orders).
    expect(collectionNodes()).toEqual([ORDERS_COLLECTION])
    const extractedToColl = ctx.graph
      .filterEdges((_id, e: GraphEdge) => e.provenance === Provenance.EXTRACTED && e.target === ORDERS_COLLECTION)
    expect(extractedToColl.length).toBeGreaterThan(0)

    // The observed span lands on the SAME node — no twin, no phantom.
    await handleSpan(ctx, mongoSpan())
    expect(collectionNodes()).toEqual([ORDERS_COLLECTION])
    expect(observedCallTargets(ctx)).toContain(ORDERS_COLLECTION)
  })
})
