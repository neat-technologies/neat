import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { advisorySource, loadAdvisorySnapshot, type InventoryItem, type OsvRecord } from '../src/advisories/index.js'

// Where advisories come from and the local cache (ADR-274, advisory-cache.md §2).
// OSV is stood in for by a fake fetch serving real records from fixtures/osv.

const FIX = path.join(__dirname, 'fixtures/osv')
const rec = (id: string) => JSON.parse(readFileSync(path.join(FIX, `${id}.json`), 'utf8')) as OsvRecord
const item = (ecosystem: string, name: string, version: string): InventoryItem => ({
  dependencyId: `dep:${ecosystem}:${name}@${version}`,
  ecosystem,
  name,
  version,
})

describe('source and cache', () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
  })
  async function env(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-adv-'))
    dirs.push(home)
    return { NEAT_HOME: home, ...extra }
  }

  // A stand-in for OSV's API: querybatch answers by package name, /v1/vulns by id.
  function fakeOsv(byName: Record<string, string[]>) {
    const calls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (url.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> }
        return new Response(
          JSON.stringify({ results: body.queries.map((q) => ({ vulns: (byName[q.package.name] ?? []).map((id) => ({ id })) })) }),
        )
      }
      const id = decodeURIComponent(url.split('/v1/vulns/')[1] ?? '')
      return new Response(JSON.stringify(rec(id)))
    }) as typeof fetch
    return { fetchImpl, calls }
  }

  it('fetches once, then serves from the cache within the TTL', async () => {
    const e = await env()
    const osv = fakeOsv({ lodash: ['GHSA-35jh-r3h4-6jhm'] })
    const inv = [item('npm', 'lodash', '4.17.15')]
    const now = () => Date.parse('2026-11-05T12:00:00Z')
    const first = await loadAdvisorySnapshot(inv, { fetchImpl: osv.fetchImpl, env: e, now })
    expect(first.source).toBe('osv')
    expect(first.snapshot!.advisories.map((a) => a.id)).toEqual(['GHSA-35jh-r3h4-6jhm'])
    expect(osv.calls.some((u) => u.startsWith('https://api.osv.dev/v1/querybatch'))).toBe(true)

    const callsAfterFirst = osv.calls.length
    const second = await loadAdvisorySnapshot(inv, { fetchImpl: osv.fetchImpl, env: e, now })
    expect(osv.calls.length).toBe(callsAfterFirst)
    expect(second.snapshot!.asOf).toBe('2026-11-05T12:00:00.000Z')
  })

  it('a failed refresh keeps serving the last good entry, and says it is stale', async () => {
    const e = await env()
    const osv = fakeOsv({ lodash: ['GHSA-35jh-r3h4-6jhm'] })
    const inv = [item('npm', 'lodash', '4.17.15')]
    await loadAdvisorySnapshot(inv, { fetchImpl: osv.fetchImpl, env: e, now: () => Date.parse('2026-11-01T00:00:00Z') })
    const failing = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    const later = await loadAdvisorySnapshot(inv, { fetchImpl: failing, env: e, now: () => Date.parse('2026-11-05T00:00:00Z') })
    expect(later.stale).toBe(1)
    expect(later.errors[0]).toMatch(/503/)
    expect(later.snapshot!.advisories.map((a) => a.id)).toEqual(['GHSA-35jh-r3h4-6jhm'])
    // The snapshot is as old as the data in it.
    expect(later.snapshot!.asOf).toBe('2026-11-01T00:00:00.000Z')
  })

  it('a mirror URL is used instead of osv.dev, and off disables everything', async () => {
    const mirror = await env({ NEAT_ADVISORIES_URL: 'https://advisories.example/' })
    const osv = fakeOsv({})
    await loadAdvisorySnapshot([item('npm', 'qs', '6.11.0')], { fetchImpl: osv.fetchImpl, env: mirror })
    expect(osv.calls[0]).toBe('https://advisories.example/v1/querybatch')
    expect(osv.calls.some((u) => u.includes('osv.dev'))).toBe(false)

    expect(advisorySource({ NEAT_ADVISORIES: 'off', NEAT_ADVISORIES_URL: 'https://x' })).toEqual({ source: 'disabled', baseUrl: null })
    const off = await loadAdvisorySnapshot([item('npm', 'qs', '6.11.0')], { fetchImpl: osv.fetchImpl, env: await env({ NEAT_ADVISORIES: 'off' }) })
    expect(off).toEqual({ source: 'disabled', snapshot: null, stale: 0, errors: [] })
  })

  it('follows querybatch pagination, so a package with many advisories is not cut off', async () => {
    const e = await env()
    let page = 0
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body)) as { queries: Array<{ page_token?: string }> }
        page++
        const second = body.queries[0]?.page_token === 'p2'
        return new Response(
          JSON.stringify({
            results: [second ? { vulns: [{ id: 'GHSA-p6mc-m468-83gw' }] } : { vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }], next_page_token: 'p2' }],
          }),
        )
      }
      return new Response(JSON.stringify(rec(decodeURIComponent(url.split('/v1/vulns/')[1] ?? ''))))
    }) as typeof fetch
    const res = await loadAdvisorySnapshot([item('npm', 'lodash', '4.17.15')], { fetchImpl, env: e })
    expect(page).toBe(2)
    expect(res.snapshot!.advisories.map((a) => a.id)).toEqual(['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'])
  })
})
