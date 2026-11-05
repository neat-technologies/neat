import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { appendConnectorIncident, buildErrorEventForReceiver, readErrorEvents } from '../src/ingest.js'
import { appendRuntimeIncident } from '../src/durable-incident.js'
import { writeExtractionErrors, recordExtractionError, drainExtractionErrors } from '../src/extract/errors.js'
import { appendUnroutedSpan, buildUnroutedSpanRecord } from '../src/unrouted.js'
import type { ParsedSpan } from '../src/otel.js'
import type { ErrorEvent } from '@neat.is/types'

// Wave 1 / #1184 #1187 — every writer of errors.ndjson, and what it can carry.
// The credential scrub (credential-scrub.ts) runs at the sink every runtime
// incident goes through, so a producer that never passed through the OTel span
// builders (EAS build failures, Kubernetes deploy failures) can't persist a
// credential header either. Writers with a fixed, attribute-free shape are
// pinned to that shape, so a new field can't slip a credential in unnoticed.

const SECRETS = ['secret-token', 'secret-session', 'sk-live-123']
const LEAKY = {
  'http.request.header.authorization': 'Bearer secret-token',
  'http.request.header.cookie': 'session=secret-session',
  'x-api-key': 'sk-live-123',
  'eas.buildPhase': 'INSTALL_DEPENDENCIES',
}

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})
async function ledger(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-scrub-'))
  dirs.push(d)
  return path.join(d, 'neat-out', 'errors.ndjson')
}
const onDisk = (p: string) => fs.readFile(p, 'utf8')
const noSecrets = (text: string) => {
  for (const s of SECRETS) expect(text).not.toContain(s)
}

describe('every errors.ndjson writer goes through the credential scrub', () => {
  it('OTel span incidents (the receiver path), written through the sink', async () => {
    const p = await ledger()
    const span = {
      service: 'orders-api', traceId: 't', spanId: 's', name: 'POST /orders', kind: 2,
      startTimeUnixNano: '0', endTimeUnixNano: '0', durationNanos: 0n,
      startTimeIso: '2026-11-05T00:00:00.000Z', statusCode: 2, attributes: { ...LEAKY },
    } as unknown as ParsedSpan
    await appendRuntimeIncident(p, 'p', buildErrorEventForReceiver(span)!, { token: undefined })
    const text = await onDisk(p)
    noSecrets(text)
    expect(JSON.parse(text).attributes['eas.buildPhase']).toBe('INSTALL_DEPENDENCIES')
  })

  it('connector incidents (EAS build failures, Kubernetes deploy failures)', async () => {
    const p = await ledger()
    await appendConnectorIncident(p, {
      id: 'eas:build:1', timestamp: '2026-11-05T00:00:00.000Z', service: 'app',
      errorType: 'eas-build-failure', errorMessage: 'build failed', attributes: { ...LEAKY },
      affectedNode: 'service:app',
    })
    const text = await onDisk(p)
    noSecrets(text)
    const ev = JSON.parse(text) as ErrorEvent
    expect(ev.attributes).toEqual({ 'eas.buildPhase': 'INSTALL_DEPENDENCIES' })
  })

  it('the hosted durable sidecar receives the scrubbed record, never the raw one', async () => {
    let body = ''
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = String(init?.body)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const ev: ErrorEvent = {
      id: 'i', timestamp: '2026-11-05T00:00:00.000Z', service: 'app', traceId: 't', spanId: 's',
      errorMessage: 'boom', attributes: { ...LEAKY }, affectedNode: 'service:app',
    }
    await appendRuntimeIncident('/nonexistent/errors.ndjson', 'p', ev, { token: 'x'.repeat(32), fetchImpl })
    noSecrets(body)
    expect(JSON.parse(body).event.attributes).toEqual({ 'eas.buildPhase': 'INSTALL_DEPENDENCIES' })
  })

  it('a record written before the scrub existed is scrubbed on read', async () => {
    const p = await ledger()
    await fs.mkdir(path.dirname(p), { recursive: true })
    const raw: ErrorEvent = {
      id: 'old', timestamp: '2026-01-01T00:00:00.000Z', service: 'app', traceId: 't', spanId: 's',
      errorMessage: 'boom', attributes: { ...LEAKY }, affectedNode: 'service:app',
    }
    await fs.writeFile(p, JSON.stringify(raw) + '\n')
    noSecrets(JSON.stringify(await readErrorEvents(p)))
  })

  it('extraction errors carry no attributes: producer, file, message only', async () => {
    const p = await ledger()
    drainExtractionErrors()
    recordExtractionError('services', 'package.json', new Error('Unexpected token'))
    await writeExtractionErrors(drainExtractionErrors(), p)
    const rec = JSON.parse(await onDisk(p))
    expect(Object.keys(rec).sort()).toEqual(expect.not.arrayContaining(['attributes']))
    expect(rec).toMatchObject({ producer: 'services', file: 'package.json', source: 'extract' })
  })

  it('unrouted spans in <NEAT_HOME>/errors.ndjson keep a fixed four-field shape', async () => {
    const home = path.dirname(await ledger())
    await appendUnroutedSpan(home, buildUnroutedSpanRecord('orders-api', 't', new Date('2026-11-05T00:00:00Z')))
    const rec = JSON.parse(await onDisk(path.join(home, 'errors.ndjson')))
    expect(Object.keys(rec).sort()).toEqual(['reason', 'service_name', 'timestamp', 'traceId'])
  })
})
