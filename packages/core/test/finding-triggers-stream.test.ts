import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApi } from '../src/api.js'
import { EVENT_BUS_CHANNEL, eventBus, type NeatEventEnvelope } from '../src/events.js'
import { getGraph, resetGraph } from '../src/graph.js'
import { FINDING_TRIGGER_STREAM_SCOPE, INCIDENT_TRIGGER_STREAM_SCOPE } from '../src/streaming.js'
import { FINDINGS_MAX_ROWS } from '../src/findings-ledger.js'

// The finding trigger stream (ADR-279, docs/contracts/finding-triggers.md §6).

const token = 'daemon-test-bearer-strong-32-chars'
const streamToken = 'incident-stream-test-bearer-32-chars'
const at = '2026-11-16T10:00:00.000Z'
const sha = 'a'.repeat(40)
const sha2 = 'b'.repeat(40)
const id = (n: number) => n.toString(16).padStart(64, '0')

const present = (n: number, commit = sha, extra: Record<string, unknown> = {}) => ({
  findingId: id(n),
  kind: 'divergence',
  affectedNode: 'service:app',
  repository: 'acme/app',
  sha: commit,
  firstSeenAt: at,
  divergenceType: 'missing-observed',
  ...extra,
})
const cleared = (n: number, commit = sha) => ({ findingId: id(n), kind: 'divergence', sha: commit, clearedAt: at, cleared: true })
const ledger = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('')

afterEach(() => resetGraph())

async function withLedger(text: string | null, run: (ctx: { address: string; findingsPath: string; errorsPath: string }) => Promise<void>, opts: Record<string, unknown> = {}): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'neat-finding-stream-'))
  const findingsPath = path.join(dir, 'findings.ndjson')
  const errorsPath = path.join(dir, 'errors.ndjson')
  if (text !== null) await writeFile(findingsPath, text)
  await writeFile(errorsPath, '')
  const app = await buildApi({ graph: getGraph(), errorsPath, findingsPath, authToken: token, incidentStreamToken: streamToken, incidentReplayDurable: true, ...opts })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  try {
    await run({ address, findingsPath, errorsPath })
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  let frames = ''
  while (!frames.includes(needle)) frames += new TextDecoder().decode((await reader.read()).value)
  return frames
}

describe('finding trigger stream', () => {
  it('requires the dedicated bearer, sets the three headers, and carries only finding rows', async () => {
    await withLedger('', async ({ address }) => {
      const controller = new AbortController()
      try {
        const url = `${address}/projects/default/finding-triggers`
        expect((await fetch(url)).status).toBe(401)
        expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
        expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)

        const response = await fetch(url, { headers: { Authorization: `Bearer ${streamToken}` }, signal: controller.signal })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(response.headers.get('x-neat-event-scope')).toBe(FINDING_TRIGGER_STREAM_SCOPE)
        expect(FINDING_TRIGGER_STREAM_SCOPE).toBe('finding-only-v1')
        expect(response.headers.get('x-neat-project')).toBe('default')
        expect(response.headers.get('x-neat-replay-complete')).toBe('1')

        const reader = response.body!.getReader()
        expect(await readUntil(reader, ':open')).toContain(':open')

        // None of these may reach the stream: another type, an incident, another
        // project's finding, and a finding payload with a field outside the row.
        eventBus.emit(EVENT_BUS_CHANNEL, {
          project: 'default', type: 'node-added',
          payload: { node: { id: 'private', sourceCode: 'PRIVATE_SOURCE_SENTINEL' } },
        } as NeatEventEnvelope)
        eventBus.emit(EVENT_BUS_CHANNEL, {
          project: 'default', type: 'incident',
          payload: { incidentId: 'inc_1', affectedNode: 'service:app', service: 'app', incidentKind: 'exception', at },
        } as NeatEventEnvelope)
        eventBus.emit(EVENT_BUS_CHANNEL, { project: 'another-project', type: 'finding', payload: present(7) } as NeatEventEnvelope)
        eventBus.emit(EVENT_BUS_CHANNEL, {
          project: 'default', type: 'finding',
          payload: present(8, sha, { reason: 'PRIVATE_SOURCE_SENTINEL' }),
        } as NeatEventEnvelope)
        eventBus.emit(EVENT_BUS_CHANNEL, { project: 'default', type: 'finding', payload: present(9, sha, { baseline: true }) } as NeatEventEnvelope)
        eventBus.emit(EVENT_BUS_CHANNEL, { project: 'default', type: 'finding', payload: present(1) } as NeatEventEnvelope)
        eventBus.emit(EVENT_BUS_CHANNEL, { project: 'default', type: 'finding', payload: cleared(1) } as NeatEventEnvelope)
        const frames = await readUntil(reader, '"cleared":true')
        expect(frames).toContain(`id: ${id(1)}:${sha}\nevent: finding\ndata: ${JSON.stringify(present(1))}\n\n`)
        expect(frames).toContain(`id: ${id(1)}:${sha}\nevent: finding\ndata: ${JSON.stringify(cleared(1))}\n\n`)
        expect(frames).not.toContain('PRIVATE_SOURCE_SENTINEL')
        expect(frames).not.toContain('event: incident')
        expect(frames).not.toContain('inc_1')
        expect(frames).not.toContain('node-added')
        expect(frames).not.toContain(id(7))
        expect(frames).not.toContain(id(8))
        expect(frames).not.toContain(id(9))
      } finally {
        controller.abort()
      }
    }, { publicRead: true })
  })

  it('is mounted unscoped as well, resolving the default project', async () => {
    await withLedger(ledger([present(1)]), async ({ address }) => {
      const controller = new AbortController()
      try {
        const response = await fetch(`${address}/finding-triggers`, { headers: { Authorization: `Bearer ${streamToken}` }, signal: controller.signal })
        expect(response.status).toBe(200)
        expect(response.headers.get('x-neat-project')).toBe('default')
        expect(await readUntil(response.body!.getReader(), id(1))).toContain('event: finding')
      } finally {
        controller.abort()
      }
    })
  })

  it('replays the ledger without its baseline rows, and after an exact cursor', async () => {
    const rows = [
      present(1, sha, { baseline: true }),
      present(2),
      cleared(1),
      present(3),
      present(2, sha2),
      cleared(3),
      { findingId: id(4), kind: 'vulnerability', affectedNode: 'service:app', repository: 'acme/app', sha: sha2, firstSeenAt: at, advisoryId: 'GHSA-35jh-r3h4-6jhm' },
    ]
    await withLedger(ledger(rows), async ({ address }) => {
      const controller = new AbortController()
      try {
        const url = `${address}/projects/default/finding-triggers`
        const headers = { Authorization: `Bearer ${streamToken}` }
        const all = await readUntil((await fetch(url, { headers, signal: controller.signal })).body!.getReader(), id(4))
        // The baseline finding and its clearing never leave the daemon.
        expect(all).not.toContain(id(1))
        expect(all).not.toContain('baseline')
        const ids = [...all.matchAll(/^id: (.+)$/gm)].map((m) => m[1])
        expect(ids).toEqual([`${id(2)}:${sha}`, `${id(3)}:${sha}`, `${id(2)}:${sha2}`, `${id(3)}:${sha}`, `${id(4)}:${sha2}`])
        expect(all).toContain(`data: ${JSON.stringify(rows[6])}`)

        const after = await fetch(url, { headers: { ...headers, 'Last-Event-ID': `${id(2)}:${sha2}` }, signal: controller.signal })
        expect(after.status).toBe(200)
        const tail = await readUntil(after.body!.getReader(), id(4))
        expect([...tail.matchAll(/^id: (.+)$/gm)].map((m) => m[1])).toEqual([`${id(3)}:${sha}`, `${id(4)}:${sha2}`])

        // Unknown, malformed and baseline cursors are all refused.
        for (const cursor of [`${id(99)}:${sha}`, 'missing', `${id(1)}:${sha}`, `${id(2)}:${'c'.repeat(40)}`]) {
          expect((await fetch(url, { headers: { ...headers, 'Last-Event-ID': cursor } })).status).toBe(409)
        }
      } finally {
        controller.abort()
      }
    })
  })

  it('refuses a corrupt ledger, a missing one and one above the bound', async () => {
    const headers = { Authorization: `Bearer ${streamToken}` }
    const status = async (text: string | null) => {
      let code = 0
      await withLedger(text, async ({ address }) => {
        const controller = new AbortController()
        code = (await fetch(`${address}/projects/default/finding-triggers`, { headers, signal: controller.signal })).status
        controller.abort()
      })
      return code
    }
    expect(await status(null)).toBe(409)
    expect(await status('not json\n')).toBe(409)
    // A torn last line.
    expect(await status(JSON.stringify(present(1)))).toBe(409)
    // A row with a field outside the contract's list.
    expect(await status(ledger([present(1, sha, { reason: 'why' })]))).toBe(409)
    const over = Array.from({ length: FINDINGS_MAX_ROWS + 1 }, (_, i) => present(i + 1))
    expect(await status(ledger(over))).toBe(409)
    expect(await status(ledger(over.slice(0, FINDINGS_MAX_ROWS)))).toBe(200)
  })

  it('is unavailable by default, without the durability assertion, and under a weak or reused token', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'neat-finding-stream-'))
    const findingsPath = path.join(dir, 'findings.ndjson')
    await writeFile(findingsPath, '')
    const attempt = async (opts: Record<string, unknown>, bearer: string) => {
      const app = await buildApi({ graph: getGraph(), findingsPath, ...opts })
      try {
        return (await app.inject({ method: 'GET', url: '/projects/default/finding-triggers', headers: { authorization: `Bearer ${bearer}` } })).statusCode
      } finally {
        await app.close()
      }
    }
    try {
      expect(await attempt({ authToken: '', incidentStreamToken: '', publicRead: true }, streamToken)).toBe(503)
      // The token alone is not the durability assertion.
      expect(await attempt({ authToken: token, incidentStreamToken: streamToken }, streamToken)).toBe(503)
      expect(await attempt({ authToken: token, incidentStreamToken: streamToken, incidentReplayDurable: false }, streamToken)).toBe(503)
      expect(await attempt({ authToken: token, incidentStreamToken: 'short', incidentReplayDurable: true }, 'short')).toBe(503)
      expect(await attempt({ authToken: token, incidentStreamToken: token, incidentReplayDurable: true }, token)).toBe(503)
      // No ledger path configured for the project.
      const app = await buildApi({ graph: getGraph(), authToken: token, incidentStreamToken: streamToken, incidentReplayDurable: true })
      try {
        const r = await app.inject({ method: 'GET', url: '/finding-triggers', headers: { authorization: `Bearer ${streamToken}` } })
        expect(r.statusCode).toBe(503)
      } finally {
        await app.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never puts a finding on the incident stream, and the general stream carries it like any other type', async () => {
    await withLedger(ledger([present(1)]), async ({ address }) => {
      const controller = new AbortController()
      try {
        const incidents = await fetch(`${address}/projects/default/incident-triggers`, { headers: { Authorization: `Bearer ${streamToken}` }, signal: controller.signal })
        expect(incidents.status).toBe(200)
        expect(incidents.headers.get('x-neat-event-scope')).toBe(INCIDENT_TRIGGER_STREAM_SCOPE)
        const general = await fetch(`${address}/projects/default/events`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        expect(general.status).toBe(200)
        expect(general.headers.get('x-neat-event-scope')).toBeNull()
        const incidentReader = incidents.body!.getReader()
        const generalReader = general.body!.getReader()
        await readUntil(incidentReader, ':open')
        await readUntil(generalReader, ':open')

        eventBus.emit(EVENT_BUS_CHANNEL, { project: 'default', type: 'finding', payload: present(5) } as NeatEventEnvelope)
        eventBus.emit(EVENT_BUS_CHANNEL, {
          project: 'default', type: 'incident',
          payload: { incidentId: 'inc_after', affectedNode: 'service:app', service: 'app', incidentKind: 'exception', at },
        } as NeatEventEnvelope)
        // The incident stream's next frame is the incident: the finding emitted
        // before it, and the finding in the ledger, never arrived.
        const incidentFrames = await readUntil(incidentReader, 'inc_after')
        expect(incidentFrames).not.toContain('event: finding')
        expect(incidentFrames).not.toContain(id(5))
        expect(incidentFrames).not.toContain(id(1))
        const generalFrames = await readUntil(generalReader, 'inc_after')
        expect(generalFrames).toContain(`event: finding\ndata: ${JSON.stringify(present(5))}\n\n`)
      } finally {
        controller.abort()
      }
    })
  })
})
