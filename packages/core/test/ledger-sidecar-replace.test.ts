import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { LEDGER_SCRUB_VERSION, ledgerScrubMarkerPath, scrubLedgerThroughSidecar } from '../src/ledger-scrub.js'

// The hosted at-rest rewrite (neat-infra #273): the daemon scrubs the ledger and
// hands it to the snapshot sidecar's verified replace. These tests stand in for
// the sidecar with a fetch that answers the status under test.

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})
async function ledger(body: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-sidecar-replace-'))
  dirs.push(d)
  const p = path.join(d, 'errors.ndjson')
  await fs.writeFile(p, body)
  return p
}

const SECRET = 'raw-' + 'secret-value'
const leaky = (id: string) => JSON.stringify({
  id, timestamp: '2026-11-01T00:00:00.000Z', service: 'app', traceId: 't', spanId: 's',
  errorMessage: `GET /x?token=${SECRET}`, affectedNode: 'service:app',
})
const clean = (id: string) => JSON.stringify({
  id, timestamp: '2026-11-01T00:00:00.000Z', service: 'app', traceId: 't', spanId: 's',
  errorMessage: 'boom', affectedNode: 'service:app',
})
const TOKEN = 'x'.repeat(32)

interface Call { url: string; project: string; ledger: string; auth: string }
function sidecar(statuses: number[], onCall?: (n: number) => Promise<void>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { project: string; ledger: string }
    calls.push({ url, project: body.project, ledger: body.ledger, auth: (init.headers as Record<string, string>).authorization })
    await onCall?.(calls.length)
    return new Response(null, { status: statuses[Math.min(calls.length - 1, statuses.length - 1)] })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const marker = async (p: string) => {
  try {
    return JSON.parse(await fs.readFile(ledgerScrubMarkerPath(p), 'utf8')).version
  } catch {
    return undefined
  }
}

describe('scrubLedgerThroughSidecar', () => {
  it('204: sends the scrubbed ledger, complete records only, and marks it done', async () => {
    const p = await ledger(`${leaky('a')}\n${clean('b')}\n{"id":"torn`)
    const s = sidecar([204])
    expect(await scrubLedgerThroughSidecar(p, 'proj', { token: TOKEN, fetchImpl: s.fetchImpl })).toEqual({
      status: 'rewritten', records: 2, scrubbed: 1,
    })
    expect(s.calls).toHaveLength(1)
    const [call] = s.calls
    expect(call!.url).toBe('http://127.0.0.1:8081/ledger-replace')
    expect(call!.project).toBe('proj')
    expect(call!.auth).toBe(`Bearer ${TOKEN}`)
    expect(call!.ledger).not.toContain(SECRET)
    expect(call!.ledger.endsWith('\n')).toBe(true)
    expect(call!.ledger.split('\n')).toHaveLength(3)
    expect(call!.ledger).not.toContain('torn')
    expect(await marker(p)).toBe(LEDGER_SCRUB_VERSION)
  })

  it('409 then 204: re-reads the ledger an append changed and resends', async () => {
    const p = await ledger(`${leaky('a')}\n`)
    // The first replace races an append; the second sees it.
    const s = sidecar([409, 204], async (n) => {
      if (n === 1) await fs.appendFile(p, `${clean('b')}\n`)
    })
    expect(await scrubLedgerThroughSidecar(p, 'proj', { token: TOKEN, fetchImpl: s.fetchImpl })).toEqual({
      status: 'rewritten', records: 2, scrubbed: 1,
    })
    expect(s.calls.map((c) => c.ledger.split('\n').length - 1)).toEqual([1, 2])
    expect(await marker(p)).toBe(LEDGER_SCRUB_VERSION)
  })

  it('409 every time: gives up after the bounded attempts and leaves it to the next start', async () => {
    const p = await ledger(`${leaky('a')}\n`)
    const s = sidecar([409])
    expect(await scrubLedgerThroughSidecar(p, 'proj', { token: TOKEN, fetchImpl: s.fetchImpl, attempts: 3 })).toEqual({ status: 'skipped-busy' })
    expect(s.calls).toHaveLength(3)
    expect(await marker(p)).toBeUndefined()
  })

  it('413: reports the ledger too large to rewrite, without marking it done', async () => {
    const p = await ledger(`${leaky('a')}\n${clean('b')}\n`)
    const s = sidecar([413])
    expect(await scrubLedgerThroughSidecar(p, 'proj', { token: TOKEN, fetchImpl: s.fetchImpl })).toEqual({
      status: 'too-large', records: 2, scrubbed: 1,
    })
    expect(s.calls).toHaveLength(1)
    expect(await marker(p)).toBeUndefined()
  })

  it('503: throws for the caller to log, without marking it done', async () => {
    const p = await ledger(`${leaky('a')}\n`)
    const s = sidecar([503])
    await expect(scrubLedgerThroughSidecar(p, 'proj', { token: TOKEN, fetchImpl: s.fetchImpl })).rejects.toThrow(/503/)
    expect(s.calls).toHaveLength(1)
    expect(await marker(p)).toBeUndefined()
  })

  it('a clean ledger, or none, never calls the sidecar', async () => {
    const p = await ledger(`${clean('a')}\n`)
    const s = sidecar([204])
    expect(await scrubLedgerThroughSidecar(p, 'proj', { token: TOKEN, fetchImpl: s.fetchImpl })).toEqual({ status: 'clean', records: 1 })
    expect(await scrubLedgerThroughSidecar(p, 'proj', { token: TOKEN, fetchImpl: s.fetchImpl })).toEqual({ status: 'current' })
    const missing = path.join(path.dirname(p), 'none.ndjson')
    expect(await scrubLedgerThroughSidecar(missing, 'proj', { token: TOKEN, fetchImpl: s.fetchImpl })).toEqual({ status: 'clean', records: 0 })
    expect(s.calls).toHaveLength(0)
  })
})
