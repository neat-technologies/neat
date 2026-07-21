import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import {
  EdgeType,
  Provenance,
  infraId,
  databaseId,
  type GraphEdge,
  type DatabaseNode,
} from '@neat.is/types'
import { parseOtlpRequest, type OtlpTracesRequest, type ParsedSpan } from '../src/otel.js'

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

// ADR-150 — the @opentelemetry/instrumentation-mongoose (the one that actually
// fires on a real mongoose app, NEAT's primary Mongo target) tags its
// per-operation spans `db.system: 'mongoose'`, not `'mongodb'`. otel.ts
// normalizes that at the parse boundary, so exercising the fix means driving the
// span through parseOtlpRequest rather than hand-building a ParsedSpan.

// A mongoose span as it arrives on the wire: db.system === 'mongoose', the
// collection under the older db.mongodb.collection key, CLIENT kind. Carries a
// peer host when one is asked for so the database-node engine can be asserted.
function mongooseOtlpBody(opts: { host?: string } = {}): OtlpTracesRequest {
  const attributes = [
    { key: 'db.system', value: { stringValue: 'mongoose' } },
    { key: 'db.mongodb.collection', value: { stringValue: 'orders' } },
    { key: 'db.operation', value: { stringValue: 'find' } },
  ]
  if (opts.host) {
    attributes.push({ key: 'server.address', value: { stringValue: opts.host } })
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'orders' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aabbccddeeff00112233445566778899',
                spanId: '1111111111111111',
                name: 'mongoose.Order.find',
                kind: 3, // CLIENT
                startTimeUnixNano: '1000000000000000000',
                endTimeUnixNano: '1000000000010000000',
                attributes,
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('MongoDB collection OBSERVED reads mongoose-system spans (ADR-150)', () => {
  let dir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetGraph()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-mongoose-observed-'))
    ctx = { graph: getGraph(), errorsPath: path.join(dir, 'errors.ndjson'), scanPath: dir }
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('normalizes db.system: mongoose to mongodb at the parse boundary', () => {
    const [span] = parseOtlpRequest(mongooseOtlpBody())
    expect(span.dbSystem).toBe('mongodb')
    // The collection read is untouched — still the older db.mongodb.collection key.
    expect(span.dbCollection).toBe('orders')
  })

  it('mints the OBSERVED CALLS edge to the collection node from a mongoose span', async () => {
    const [span] = parseOtlpRequest(mongooseOtlpBody())
    await handleSpan(ctx, span)
    expect(collectionNodes()).toEqual([ORDERS_COLLECTION])
    expect(observedCallTargets(ctx)).toContain(ORDERS_COLLECTION)
  })

  it('gives the peer-host database node engine mongodb, not mongoose', async () => {
    const host = 'cluster0.abcde.mongodb.net'
    const [span] = parseOtlpRequest(mongooseOtlpBody({ host }))
    await handleSpan(ctx, span)
    const dbId = databaseId(host)
    expect(ctx.graph.hasNode(dbId)).toBe(true)
    const node = ctx.graph.getNodeAttributes(dbId) as DatabaseNode
    expect(node.engine).toBe('mongodb')
  })
})
