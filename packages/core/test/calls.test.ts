import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, InfraNode } from '@neat.is/types'
import { EdgeType } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'calls')

describe('call extraction beyond HTTP', () => {
  beforeEach(() => resetGraph())

  it('emits PUBLISHES_TO + CONSUMES_FROM kafka edges with evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    expect(graph.hasNode('infra:kafka-topic:orders')).toBe(true)
    expect(graph.hasNode('infra:kafka-topic:shipments')).toBe(true)

    const ordersTopic = graph.getNodeAttributes('infra:kafka-topic:orders') as InfraNode
    expect(ordersTopic.kind).toBe('kafka-topic')
    expect(ordersTopic.name).toBe('orders')

    // File-first (ADR-089): the relationship originates from the file the call
    // site lives in, with the owning service ──CONTAINS──▶ file alongside it.
    expect(graph.hasNode('file:fixture-kafka-service:index.js')).toBe(true)
    expect(
      graph.hasEdge('CONTAINS:service:fixture-kafka-service->file:fixture-kafka-service:index.js'),
    ).toBe(true)

    const publishEdgeId =
      'PUBLISHES_TO:file:fixture-kafka-service:index.js->infra:kafka-topic:orders'
    expect(graph.hasEdge(publishEdgeId)).toBe(true)
    const publishEdge = graph.getEdgeAttributes(publishEdgeId) as GraphEdge
    expect(publishEdge.evidence?.file).toBe('index.js')
    expect(publishEdge.evidence?.line).toBeGreaterThan(0)
    expect(publishEdge.evidence?.snippet).toContain('orders')

    const consumeEdgeId =
      'CONSUMES_FROM:file:fixture-kafka-service:index.js->infra:kafka-topic:shipments'
    expect(graph.hasEdge(consumeEdgeId)).toBe(true)
  })

  it('emits redis InfraNode + CALLS edge from a redis:// URL', async () => {
    // ADR-066 — `redis://host` URL literals grade at the url-with-structural-
    // support tier (0.5) and drop below the default precision floor (0.7).
    // The detector still runs; flip the floor off here so the test exercises
    // full recall and proves the matcher works.
    const prev = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0'
    try {
      const graph = getGraph()
      await extractFromDirectory(graph, FIXTURES)

      expect(graph.hasNode('infra:redis:cache.internal')).toBe(true)
      const redisNode = graph.getNodeAttributes('infra:redis:cache.internal') as InfraNode
      expect(redisNode.kind).toBe('redis')

      const edgeId = 'CALLS:file:fixture-redis-service:index.js->infra:redis:cache.internal'
      expect(graph.hasEdge(edgeId)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
      else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prev
    }
  })

  it('emits S3 + DynamoDB InfraNodes from AWS SDK calls', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const bucket = graph.getNodeAttributes('infra:s3-bucket:invoices') as InfraNode
    expect(bucket.provider).toBe('aws')
    expect(bucket.kind).toBe('s3-bucket')

    const table = graph.getNodeAttributes('infra:dynamodb-table:orders-table') as InfraNode
    expect(table.kind).toBe('dynamodb-table')
  })

  it('emits a gRPC infra node + CALLS edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    expect(graph.hasNode('infra:grpc-service:orders.internal:50051')).toBe(true)
    const edgeId =
      'CALLS:file:fixture-grpc-service:index.js->infra:grpc-service:orders.internal:50051'
    expect(graph.hasEdge(edgeId)).toBe(true)
  })

  it('emits supabase CALLS edges for both literal and env-driven client URLs', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // Literal `https://abcdefgh.supabase.co` URL → the real host resolves.
    expect(graph.hasNode('infra:supabase:abcdefgh.supabase.co')).toBe(true)
    const litNode = graph.getNodeAttributes(
      'infra:supabase:abcdefgh.supabase.co',
    ) as InfraNode
    expect(litNode.kind).toBe('supabase')

    const litEdgeId =
      'CALLS:file:fixture-supabase-service:index.ts->infra:supabase:abcdefgh.supabase.co'
    expect(graph.hasEdge(litEdgeId)).toBe(true)
    const litEdge = graph.getEdgeAttributes(litEdgeId) as GraphEdge
    expect(litEdge.evidence?.file).toBe('index.ts')
    expect(litEdge.evidence?.line).toBeGreaterThan(0)
    expect(litEdge.evidence?.snippet).toContain('createClient')

    // Env-driven `process.env.SUPABASE_URL` → the host is unknowable, so the
    // edge lands on the stable `supabase:env` target rather than a guessed host.
    // This is the edge that kills the false `missing-extracted` divergence.
    expect(graph.hasNode('infra:supabase:env')).toBe(true)
    const envEdgeId =
      'CALLS:file:fixture-supabase-service:index.ts->infra:supabase:env'
    expect(graph.hasEdge(envEdgeId)).toBe(true)
  })

  it('does not emit supabase edges from a test file (test-scope exclusion)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // The __tests__/client.spec.ts fixture constructs a client against
    // testonly.supabase.co — ADR-065 #1 keeps it from minting an outbound
    // CALLS edge. (The test file is still registered service-internal via its
    // structural CONTAINS edge; only outbound inference is filtered.)
    expect(graph.hasNode('infra:supabase:testonly.supabase.co')).toBe(false)
    graph.forEachEdge((id, attrs) => {
      const e = attrs as GraphEdge
      if (e.type !== EdgeType.CALLS) return
      expect(id).not.toContain('client.spec.ts')
    })
  })
})
