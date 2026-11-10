import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { EdgeType, infraId } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, resetParentSpanCache, type IngestContext } from '../src/ingest.js'

// socket.io destinations are event-grained (otel-ingest.md, refs #1603). The
// attribute shapes below are what @opentelemetry/instrumentation-socket.io 0.41
// writes: the namespace in messaging.destination, the event in its own key.

function span(service: string, kind: number, attrs: Record<string, string>, spanId: string): OtlpTracesRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aabbccddeeff00112233445566778899',
                spanId,
                name: 'socket.io',
                kind,
                startTimeUnixNano: '1000000000000000000',
                endTimeUnixNano: '1000000000050000000',
                attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  }
}
const PRODUCER = 4
const CONSUMER = 5
const emit = (ns: string, event: string) => ({
  'messaging.system': 'socket.io',
  'messaging.destination_kind': 'topic',
  'messaging.socket.io.event_name': event,
  'messaging.socket.io.namespace': ns,
  'messaging.destination': ns,
})
const listen = (ns: string, event: string) => ({
  'messaging.system': 'socket.io',
  'messaging.destination': ns,
  'messaging.operation': 'receive',
  'messaging.socket.io.event_name': event,
})
const topic = (dest: string) => infraId('socket.io-topic', dest)

describe('socket.io event grain', () => {
  let ctx: IngestContext
  beforeEach(() => {
    resetGraph()
    resetParentSpanCache()
    ctx = { graph: getGraph(), errorsPath: path.join(os.tmpdir(), 'neat-1603-errors.ndjson') }
  })

  it('gives each event its own destination, keyed under its namespace', () => {
    const [a] = parseOtlpRequest(span('chat', PRODUCER, emit('/', 'chat message'), '1111111111111111'))
    const [b] = parseOtlpRequest(span('chat', CONSUMER, listen('/admin', 'update'), '2222222222222222'))
    expect(a!.messagingDestination).toBe('/#chat message')
    expect(b!.messagingDestination).toBe('/admin#update')
  })

  it('mints one node per event, publisher and listener meeting on it', async () => {
    const spans = [
      span('chat', PRODUCER, emit('/', 'chat message'), '1111111111111111'),
      span('chat', PRODUCER, emit('/', 'typing'), '2222222222222222'),
      span('chat', CONSUMER, listen('/', 'chat message'), '3333333333333333'),
    ]
    for (const req of spans) for (const s of parseOtlpRequest(req)) await handleSpan(ctx, s)
    const g = getGraph()
    expect(g.hasNode(topic('/'))).toBe(false)
    expect(g.hasNode(topic('/#typing'))).toBe(true)
    const into = (id: string, type: string) => g.inEdges(id).filter((e) => g.getEdgeAttributes(e).type === type).length
    expect(into(topic('/#chat message'), EdgeType.PUBLISHES_TO)).toBe(1)
    expect(into(topic('/#chat message'), EdgeType.CONSUMES_FROM)).toBe(1)
  })

  it('keeps a namespace event apart from a namespace of the same name', () => {
    const [a] = parseOtlpRequest(span('chat', PRODUCER, emit('/', 'chat'), '1111111111111111'))
    const [b] = parseOtlpRequest(span('chat', PRODUCER, { 'messaging.system': 'socket.io', 'messaging.destination': '/chat' }, '2222222222222222'))
    expect(a!.messagingDestination).not.toBe(b!.messagingDestination)
  })

  it('falls back to the namespace without an event, and leaves other systems alone', () => {
    const [a] = parseOtlpRequest(span('chat', PRODUCER, { 'messaging.system': 'socket.io', 'messaging.destination': '/' }, '1111111111111111'))
    const [b] = parseOtlpRequest(
      span('api', PRODUCER, { 'messaging.system': 'kafka', 'messaging.destination.name': 'orders', 'messaging.socket.io.event_name': 'x' }, '2222222222222222'),
    )
    expect(a!.messagingDestination).toBe('/')
    expect(b!.messagingDestination).toBe('orders')
  })
})
