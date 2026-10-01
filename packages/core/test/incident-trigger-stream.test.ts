import { afterEach, describe, expect, it } from 'vitest'
import { buildApi } from '../src/api.js'
import { EVENT_BUS_CHANNEL, eventBus, type NeatEventEnvelope } from '../src/events.js'
import { getGraph, resetGraph } from '../src/graph.js'
import { INCIDENT_TRIGGER_STREAM_SCOPE } from '../src/streaming.js'

const token = 'daemon-test-bearer'

afterEach(() => resetGraph())

describe('hosted incident trigger stream', () => {
  it('requires a bearer even when graph reads are public, and emits only bounded lean incidents', async () => {
    const app = await buildApi({ graph: getGraph(), authToken: token, publicRead: true })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const controller = new AbortController()
    try {
      const url = `${address}/projects/default/incident-triggers`
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(response.headers.get('x-neat-event-scope')).toBe(INCIDENT_TRIGGER_STREAM_SCOPE)

      const reader = response.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain(':open')

      eventBus.emit(EVENT_BUS_CHANNEL, {
        project: 'default', type: 'node-added',
        payload: { node: { id: 'private', sourceCode: 'PRIVATE_SOURCE_SENTINEL' } },
      } as NeatEventEnvelope)
      eventBus.emit(EVENT_BUS_CHANNEL, {
        project: 'another-project', type: 'incident',
        payload: { incidentId: 'wrong', affectedNode: 'service:wrong', service: 'wrong', incidentKind: 'exception', at: new Date().toISOString() },
      } as NeatEventEnvelope)
      eventBus.emit(EVENT_BUS_CHANNEL, {
        project: 'default', type: 'incident',
        payload: { incidentId: 'inc_1', affectedNode: 'service:app', service: 'app', incidentKind: 'exception', at: new Date().toISOString(), sourceCode: 'PRIVATE_SOURCE_SENTINEL' },
      } as NeatEventEnvelope)
      const next = await reader.read()
      const frame = new TextDecoder().decode(next.value)
      expect(frame).toContain('event: incident')
      expect(frame).toContain('"incidentId":"inc_1"')
      expect(frame).not.toContain('PRIVATE_SOURCE_SENTINEL')
      expect(frame).not.toContain('node-added')
      expect(frame).not.toContain('wrong')
    } finally {
      controller.abort()
      await app.close()
    }
  })

  it('stays unavailable without an operator bearer', async () => {
    const app = await buildApi({ graph: getGraph(), authToken: '', publicRead: true })
    try {
      const response = await app.inject({ method: 'GET', url: '/projects/default/incident-triggers' })
      expect(response.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })
})
