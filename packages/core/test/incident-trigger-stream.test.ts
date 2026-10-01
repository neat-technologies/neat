import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApi } from '../src/api.js'
import { EVENT_BUS_CHANNEL, eventBus, type NeatEventEnvelope } from '../src/events.js'
import { getGraph, resetGraph } from '../src/graph.js'
import { INCIDENT_TRIGGER_STREAM_SCOPE } from '../src/streaming.js'

const token = 'daemon-test-bearer-strong-32-chars'
const streamToken = 'incident-stream-test-bearer-32-chars'

afterEach(() => resetGraph())

describe('hosted incident trigger stream', () => {
  it('requires a bearer even when graph reads are public, and emits only bounded lean incidents', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'neat-trigger-stream-'))
    const errorsPath = path.join(dir, 'errors.ndjson')
    await writeFile(errorsPath, '')
    const app = await buildApi({ graph: getGraph(), errorsPath, authToken: token, incidentStreamToken: streamToken, incidentReplayDurable: true, publicRead: true })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const controller = new AbortController()
    try {
      const url = `${address}/projects/default/incident-triggers`
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
      expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${streamToken}` },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(response.headers.get('x-neat-event-scope')).toBe(INCIDENT_TRIGGER_STREAM_SCOPE)
      expect(response.headers.get('x-neat-project')).toBe('default')
      expect(response.headers.get('x-neat-replay-complete')).toBe('1')

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
      expect(frame).toContain('id: inc_1')
      expect(frame).toContain('"incidentId":"inc_1"')
      expect(frame).not.toContain('PRIVATE_SOURCE_SENTINEL')
      expect(frame).not.toContain('node-added')
      expect(frame).not.toContain('wrong')
    } finally {
      controller.abort()
      await app.close()
      await rm(dir, {recursive:true,force:true})
    }
  })

  it('replays after an exact incident cursor and refuses a lost cursor', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'neat-trigger-replay-'))
    const errorsPath = path.join(dir, 'errors.ndjson')
    const at = new Date().toISOString()
    const record = (id: string) => ({id,timestamp:at,service:'app',traceId:id,spanId:id,errorMessage:'PRIVATE_SOURCE_SENTINEL',affectedNode:'service:app'})
    await writeFile(errorsPath,`${JSON.stringify(record('trace_1:span_1'))}\n${JSON.stringify(record('trace_2:span_2'))}\n`)
    const app = await buildApi({graph:getGraph(),errorsPath,authToken:token,incidentStreamToken:streamToken,incidentReplayDurable:true})
    const address = await app.listen({host:'127.0.0.1',port:0})
    const controller = new AbortController()
    try {
      const url = `${address}/projects/default/incident-triggers`
      const headers = {Authorization:`Bearer ${streamToken}`,'Last-Event-ID':'trace_1:span_1'}
      const response = await fetch(url,{headers,signal:controller.signal})
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      let frames = ''
      while (!frames.includes('id: trace_2:span_2')) frames += new TextDecoder().decode((await reader.read()).value)
      expect(frames).not.toContain('id: trace_1:span_1')
      expect(frames).not.toContain('PRIVATE_SOURCE_SENTINEL')
      expect((await fetch(url,{headers:{...headers,'Last-Event-ID':'missing'}})).status).toBe(409)
    } finally {controller.abort();await app.close();await rm(dir,{recursive:true,force:true})}
  })

  it('stays unavailable without an operator bearer', async () => {
    const app = await buildApi({ graph: getGraph(), authToken: '', incidentStreamToken: '', publicRead: true })
    try {
      const response = await app.inject({ method: 'GET', url: '/projects/default/incident-triggers' })
      expect(response.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('refuses a stream token that is also the general graph bearer', async () => {
    const app = await buildApi({ graph: getGraph(), authToken: token, incidentStreamToken: token })
    try {
      const response = await app.inject({ method: 'GET', url: '/incident-triggers', headers: { authorization: `Bearer ${token}` } })
      expect(response.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('does not grant graph access to the incident-stream bearer', async () => {
    const app = await buildApi({ graph: getGraph(), authToken: token, incidentStreamToken: streamToken })
    try {
      const response = await app.inject({ method: 'GET', url: '/graph', headers: { authorization: `Bearer ${streamToken}` } })
      expect(response.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})
