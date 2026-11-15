import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EdgeType, NodeType, type ErrorEvent, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { buildOtelReceiver, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, makeErrorSpanWriter, readErrorEvents, type IngestContext } from '../src/ingest.js'
import { IncidentRetryQueue, incidentRetry } from '../src/incident-retry.js'
import { startConnectorPollLoop, type ConnectorContext } from '../src/connectors/index.js'
import type { ObservedConnector, ObservedSignal } from '../src/connectors/types.js'

// #1678, ruled by Deniz 2026-11-15: when an incident can't be stored, everything
// else is kept and the lost incident is counted. The sink here fails for real: the
// ledger's parent directory is a regular file, so every append is ENOTDIR until
// the test turns it back into a directory.

const PROJECT = 'sink-test'
let dir: string
let blocker: string
let errorsPath: string

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

async function failSink(): Promise<void> {
  await fs.writeFile(blocker, 'not a directory')
}

async function healSink(): Promise<void> {
  await fs.rm(blocker, { force: true })
  await fs.mkdir(blocker, { recursive: true })
}

beforeEach(async () => {
  incidentRetry.reset()
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-sink-'))
  blocker = path.join(dir, 'neat-out')
  errorsPath = path.join(blocker, 'errors.ndjson')
  await failSink()
})

afterEach(async () => {
  incidentRetry.reset()
  await fs.rm(dir, { recursive: true, force: true })
})

// One healthy CLIENT span from checkout to payments, and one ERROR span.
const BATCH: OtlpTracesRequest = {
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] },
    scopeSpans: [{
      spans: [
        {
          traceId: 'aabbccddeeff00112233445566778899', spanId: '1111111111111111', name: 'POST /charge', kind: 3,
          startTimeUnixNano: '1763200000000000000', endTimeUnixNano: '1763200000050000000',
          attributes: [{ key: 'server.address', value: { stringValue: 'payments' } }],
          status: { code: 0 },
        },
        {
          traceId: 'aabbccddeeff00112233445566778899', spanId: '2222222222222222', name: 'GET /cart', kind: 2,
          startTimeUnixNano: '1763200000000000000', endTimeUnixNano: '1763200000050000000',
          attributes: [],
          status: { code: 2, message: 'boom' },
          events: [{
            name: 'exception', timeUnixNano: '1763200000040000000',
            attributes: [{ key: 'exception.message', value: { stringValue: 'cart lookup failed' } }],
          }],
        },
      ],
    }],
  }],
}

describe('a failing incident sink keeps everything else (#1678)', () => {
  it('accepts a batch with an error span, lands its healthy spans and edges, and stores the incident once the sink recovers', async () => {
    const graph = newGraph()
    const ctx: IngestContext = { graph, errorsPath, project: PROJECT, writeErrorEventInline: false }
    const app = await buildOtelReceiver({
      onSpan: (span) => handleSpan(ctx, span),
      onErrorSpanSync: makeErrorSpanWriter(errorsPath, graph, undefined, PROJECT),
    })
    try {
      const res = await app.inject({
        method: 'POST', url: '/v1/traces', headers: { 'content-type': 'application/json' }, payload: BATCH,
      })
      expect(res.statusCode).toBe(200)
      await (app as unknown as { flushPending: () => Promise<void> }).flushPending()

      // The healthy span's edge landed although the batch's incident didn't.
      expect(graph.hasNode('service:checkout')).toBe(true)
      expect(graph.outboundEdges('service:checkout').length).toBeGreaterThan(0)
      expect(incidentRetry.health(PROJECT)).toEqual({ pending: 1, dropped: 0, failing: true })

      await healSink()
      await incidentRetry.retryNow()
      const stored = await readErrorEvents(errorsPath)
      expect(stored).toHaveLength(1)
      expect(stored[0]!.errorMessage).toBe('cart lookup failed')
      expect(incidentRetry.health(PROJECT)).toEqual({ pending: 0, dropped: 0, failing: false })
    } finally {
      await app.close()
    }
  })

  it('runs the rest of handleSpan when the queued incident write fails', async () => {
    const graph = newGraph()
    let policyRuns = 0
    const ctx: IngestContext = {
      graph, errorsPath, project: PROJECT,
      onPolicyTrigger: async () => { policyRuns++ },
    }
    const app = await buildOtelReceiver({ onSpan: (span) => handleSpan(ctx, span) })
    try {
      await app.inject({
        method: 'POST', url: '/v1/traces', headers: { 'content-type': 'application/json' }, payload: BATCH,
      })
      await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
      // Both spans reached the post-ingest policy trigger; the incident is held.
      expect(policyRuns).toBe(2)
      expect(incidentRetry.health(PROJECT).pending).toBe(1)
    } finally {
      await app.close()
    }
  })

  it("advances a connector's cursor past a poll whose incident could not be stored", async () => {
    const graph = newGraph()
    graph.addNode('service:web', { id: 'service:web', type: NodeType.ServiceNode, name: 'web', language: 'javascript' })
    graph.addNode('service:api', { id: 'service:api', type: NodeType.ServiceNode, name: 'api', language: 'javascript' })
    const sinces: Array<string | undefined> = []
    const at = new Date().toISOString()
    const incident: ObservedSignal = {
      targetKind: 'service', targetName: 'web', callCount: 0, errorCount: 1, lastObservedIso: at,
      incident: {
        id: 'test:deploy:1', timestamp: at, service: 'web',
        errorType: 'deploy-failure', errorMessage: 'rollout failed',
      },
    }
    const traffic: ObservedSignal = {
      targetKind: 'service', targetName: 'api', callCount: 3, errorCount: 0, lastObservedIso: at,
    }
    const connector: ObservedConnector = {
      provider: 'test',
      poll: async (pollCtx) => {
        sinces.push(pollCtx.since)
        return [incident, traffic]
      },
    }
    const ctx: ConnectorContext = { projectDir: dir, credentials: {}, errorsPath, project: PROJECT }
    const errors: unknown[] = []
    const stop = startConnectorPollLoop(
      connector, ctx, graph,
      (signal) => ({
        targetNodeId: `service:${signal.targetName}`, serviceName: 'web', edgeType: EdgeType.CALLS,
      }),
      { intervalMs: 20, onError: (err) => errors.push(err) },
    )
    try {
      await expect.poll(() => sinces.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(2)
    } finally {
      stop()
    }
    expect(errors).toEqual([])
    expect(sinces[0]).toBeUndefined()
    // The second tick asked for "since the first tick", not the same window again.
    expect(sinces[1]).toBeDefined()
    // The traffic signal after the incident still minted its edge.
    expect(graph.outboundEdges('service:web').length).toBeGreaterThan(0)
    expect(incidentRetry.health(PROJECT).pending).toBeGreaterThan(0)
  })
})

describe('the incident retry queue', () => {
  const event = (id: string): ErrorEvent => ({
    id, timestamp: '2026-11-15T00:00:00.000Z', service: 's', traceId: id, spanId: id,
    errorMessage: 'failed', affectedNode: 'service:s',
  })

  it('drops the oldest held incident at the cap, counts it, and logs once per state change', async () => {
    let up = false
    const written: string[] = []
    const lines: string[] = []
    const stored: string[] = []
    const queue = new IncidentRetryQueue({
      cap: 2,
      retryMs: 60_000,
      log: (line) => lines.push(line),
      write: async (_p, _project, ev) => {
        if (!up) throw new Error('sink down')
        written.push(ev.id)
      },
    })
    try {
      for (const id of ['a', 'b', 'c', 'd']) {
        expect(await queue.store('/x', 'p', event(id), (ev) => stored.push(ev.id))).toBe(false)
      }
      expect(queue.health('p')).toEqual({ pending: 2, dropped: 2, failing: true })
      // One line for "failing", one for "dropping"; not one per incident.
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('failing')
      expect(lines[1]).toContain('dropping the oldest')

      // Still down: a retry stores nothing and logs nothing.
      await queue.retryNow()
      expect(lines).toHaveLength(2)

      up = true
      await queue.retryNow()
      // The two newest survived and were stored in order; the bus hook fired for them only.
      expect(written).toEqual(['c', 'd'])
      expect(stored).toEqual(['c', 'd'])
      expect(queue.health('p')).toEqual({ pending: 0, dropped: 2, failing: false })
      expect(lines).toHaveLength(3)
      expect(lines[2]).toContain('recovered')
      expect(lines[2]).toContain('stored 2')
      expect(lines[2]).toContain('2 dropped')

      // A healthy sink stores straight through.
      expect(await queue.store('/x', 'p', event('e'))).toBe(true)
      expect(written).toEqual(['c', 'd', 'e'])
    } finally {
      queue.reset()
    }
  })

  it('holds a new incident behind older held ones, so the ledger keeps arrival order', async () => {
    let up = false
    const written: string[] = []
    const queue = new IncidentRetryQueue({
      retryMs: 60_000,
      log: () => {},
      write: async (_p, _project, ev) => {
        if (!up) throw new Error('sink down')
        written.push(ev.id)
      },
    })
    try {
      await queue.store('/x', 'p', event('a'))
      up = true
      // The sink is back, but 'a' is still held, so 'b' waits behind it.
      expect(await queue.store('/x', 'p', event('b'))).toBe(false)
      await queue.retryNow()
      expect(written).toEqual(['a', 'b'])
    } finally {
      queue.reset()
    }
  })

  it('counts an incident lost before it reached the sink', () => {
    const lines: string[] = []
    const queue = new IncidentRetryQueue({ log: (line) => lines.push(line) })
    queue.lost('p', new Error('no slot'))
    queue.lost('p', new Error('no slot'))
    expect(queue.health('p')).toEqual({ pending: 0, dropped: 2, failing: false })
    expect(lines).toHaveLength(1)
  })
})
