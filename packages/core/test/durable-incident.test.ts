import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ErrorEvent } from '@neat.is/types'
import { appendRuntimeIncident } from '../src/durable-incident.js'

const dirs: string[] = []
const event: ErrorEvent = {
  id: 'trace:span', timestamp: '2026-10-01T00:00:00.000Z', service: 'service',
  traceId: 'trace', spanId: 'span', errorMessage: 'failed', affectedNode: 'service:service',
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('durable incident append', () => {
  it('waits for the sidecar commitment and never writes a competing local record', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neat-durable-'))
    dirs.push(dir)
    const file = path.join(dir, 'errors.ndjson')
    let accepted = false
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ project: 'default', event })
      accepted = true
      return new Response(null, { status: 204 })
    }) as typeof fetch
    await appendRuntimeIncident(file, 'default', event, { token: 'x'.repeat(32), fetchImpl })
    expect(accepted).toBe(true)
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses sidecar failure without a local fallback', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neat-durable-'))
    dirs.push(dir)
    const file = path.join(dir, 'errors.ndjson')
    const fetchImpl = (async () => new Response(null, { status: 503 })) as typeof fetch
    await expect(appendRuntimeIncident(file, 'default', event, { token: 'x'.repeat(32), fetchImpl }))
      .rejects.toThrow('durable incident sink unavailable')
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
