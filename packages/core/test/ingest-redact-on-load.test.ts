import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readErrorEvents } from '../src/ingest.js'
import type { ErrorEvent } from '@neat.is/types'

// The write-path scrub (#1184) only guards new records. These sit on disk from
// a run before the fix — readErrorEvents must scrub them on load so no reader
// ever sees the credential.
async function writeSidecar(records: ErrorEvent[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'neat-redact-load-'))
  const path = join(dir, 'errors.ndjson')
  await writeFile(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return path
}

function record(id: string, attributes: ErrorEvent['attributes']): ErrorEvent {
  return {
    id,
    timestamp: '2026-09-01T00:00:00.000Z',
    service: 'orders-api',
    traceId: id.split(':')[0],
    spanId: id.split(':')[1],
    errorMessage: 'boom',
    affectedNode: 'service:orders-api',
    ...(attributes ? { attributes } : {}),
  }
}

describe('readErrorEvents redacts credential headers already on disk (#1186)', () => {
  it('drops cookie / authorization / api-key lines from persisted records, keeps the rest', async () => {
    const path = await writeSidecar([
      record('trace-1:span-1', {
        'http.request.header.cookie': 'session=secret-session',
        'http.request.header.authorization': 'Bearer secret-token',
        authorization: 'Bearer bare-token',
        'http.request.header.x-api-key': 'sk-live-123',
        'code.filepath': 'app/orders.py',
        'http.route': '/orders',
        'http.response.status_code': 500,
      }),
    ])
    const [ev] = await readErrorEvents(path)
    const a = ev.attributes ?? {}
    expect(a['http.request.header.cookie']).toBeUndefined()
    expect(a['http.request.header.authorization']).toBeUndefined()
    expect(a['authorization']).toBeUndefined()
    expect(a['http.request.header.x-api-key']).toBeUndefined()
    const dumped = JSON.stringify(a)
    expect(dumped).not.toContain('secret')
    expect(dumped).not.toContain('sk-live-123')
    expect(dumped).not.toContain('bare-token')
    // Attribution and status survive.
    expect(a['code.filepath']).toBe('app/orders.py')
    expect(a['http.route']).toBe('/orders')
    expect(a['http.response.status_code']).toBe(500)
  })

  it('drops the attributes key entirely when a record carried only credentials', async () => {
    const path = await writeSidecar([
      record('trace-2:span-2', {
        'http.request.header.cookie': 'session=only-secret',
      }),
    ])
    const [ev] = await readErrorEvents(path)
    expect(ev.attributes).toBeUndefined()
  })

  it('leaves a record with no sensitive attributes untouched', async () => {
    const clean = record('trace-3:span-3', {
      'code.filepath': 'app/main.py',
      'http.route': '/health',
    })
    const path = await writeSidecar([clean])
    const [ev] = await readErrorEvents(path)
    expect(ev.attributes).toEqual({
      'code.filepath': 'app/main.py',
      'http.route': '/health',
    })
  })
})
