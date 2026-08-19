import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, InfraNode } from '@neat.is/types'
import { EdgeType, Provenance } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'kafka-go')

// The otel-demo `checkout` service is Go on Sarama; its observed
// `PUBLISHES_TO infra:kafka-topic:orders` edge had no static twin because the
// kafka recognizer only matched the kafkajs / node-rdkafka JS shape. These
// exercise the Go Sarama path — producer struct literals, a const-resolved
// topic, an honestly-skipped env-only topic, and a consumer-group subscribe.
describe('Go Sarama kafka topic extraction', () => {
  beforeEach(() => resetGraph())

  it('mints infra:kafka-topic:orders + PUBLISHES_TO from a Sarama ProducerMessage literal', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    expect(graph.hasNode('infra:kafka-topic:orders')).toBe(true)
    const orders = graph.getNodeAttributes('infra:kafka-topic:orders') as InfraNode
    expect(orders.kind).toBe('kafka-topic')
    expect(orders.name).toBe('orders')

    // File-first (ADR-089): the relationship originates from the Go file the
    // call site lives in, with the owning service ──CONTAINS──▶ file alongside.
    expect(graph.hasNode('file:checkout:producer.go')).toBe(true)
    expect(graph.hasEdge('CONTAINS:service:checkout->file:checkout:producer.go')).toBe(true)

    const publishId = 'PUBLISHES_TO:file:checkout:producer.go->infra:kafka-topic:orders'
    expect(graph.hasEdge(publishId)).toBe(true)
    const publish = graph.getEdgeAttributes(publishId) as GraphEdge
    expect(publish.provenance).toBe(Provenance.EXTRACTED)
    expect(publish.confidence).toBeGreaterThanOrEqual(0.7)
    expect(publish.evidence?.file).toBe('producer.go')
    expect(publish.evidence?.line).toBeGreaterThan(0)
    expect(publish.evidence?.snippet).toContain('orders')
  })

  it('resolves a package-const topic to its in-file literal (payments)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // `const paymentsTopic = "payments"` used as `ProducerMessage{Topic: paymentsTopic}`.
    // Nothing else in the fixture set names `payments`, so its presence proves the
    // const resolved to its literal.
    expect(graph.hasNode('infra:kafka-topic:payments')).toBe(true)
    expect(
      graph.hasEdge('PUBLISHES_TO:file:checkout:producer.go->infra:kafka-topic:payments'),
    ).toBe(true)
  })

  it('leaves an env-only topic unextracted and never mints from a comment', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // `os.Getenv("KAFKA_EXTRA_TOPIC")` has no in-file literal — NEAT can't see the
    // topic name, so it stays out of the graph rather than being guessed. The
    // checkout file therefore publishes to exactly the two topics it names in
    // source: orders (literal) and payments (const).
    const published = new Set<string>()
    graph.forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.PUBLISHES_TO && e.source === 'file:checkout:producer.go') {
        published.add(e.target)
      }
    })
    expect(published).toEqual(
      new Set(['infra:kafka-topic:orders', 'infra:kafka-topic:payments']),
    )

    // The comment body `ProducerMessage{Topic: "ghost-topic"}` is masked before the
    // recognizer runs (ADR-065 #2), so no phantom topic node appears.
    expect(graph.hasNode('infra:kafka-topic:ghost-topic')).toBe(false)
  })

  it('mints CONSUMES_FROM from a Sarama consumer-group Consume([]string{...})', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    expect(graph.hasNode('file:fraud-detection:consumer.go')).toBe(true)
    const consumeId =
      'CONSUMES_FROM:file:fraud-detection:consumer.go->infra:kafka-topic:orders'
    expect(graph.hasEdge(consumeId)).toBe(true)
    const consume = graph.getEdgeAttributes(consumeId) as GraphEdge
    expect(consume.provenance).toBe(Provenance.EXTRACTED)
    expect(consume.evidence?.file).toBe('consumer.go')
    expect(consume.evidence?.snippet).toContain('orders')
  })
})
