import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { foldAliases, normalizeOsv, type Advisory, type OsvRecord } from './normalize.js'
import type { AdvisorySnapshot, InventoryItem } from './match.js'
import { buildFixDiff } from './release-fetch.js'
import type { FixDiff } from './fixdiff.js'

// Where advisories come from, and the local cache (advisory-cache.md §2).
//
//   1. a NEAT-hosted mirror (NEAT_ADVISORIES_URL), which serves OSV's query API
//      so a project's inventory doesn't go to a third party;
//   2. OSV itself (api.osv.dev), which does receive the package names and
//      versions. `neat doctor` and every `neat security` run say so
//      (advisoryDisclosure, below);
//   3. the bulk export, for offline use. That arrives in a later pass.
//
// NEAT_ADVISORIES=off turns all of it off, and callers then report "advisories
// disabled", never "no vulnerabilities".

export const OSV_API = 'https://api.osv.dev'

/**
 * The one line that says where a project's dependency list goes when advisories
 * are looked up (advisory-cache.md §2). Shared by `neat doctor`, the `neat
 * security` commands and the daemon's dependency-code loop, so they never word it
 * differently. `sendsInventory` is true when the package names and versions leave
 * the machine for a third party (OSV queried directly).
 */
export function advisoryDisclosure(
  source: AdvisorySource,
  baseUrl?: string | null,
): { source: AdvisorySource; sendsInventory: boolean; line: string } {
  if (source === 'osv') {
    return {
      source,
      sendsInventory: true,
      line:
        'Advisories: querying api.osv.dev directly; your dependency names and versions are sent to OSV. ' +
        'Set NEAT_ADVISORIES_URL for a hosted mirror, or NEAT_ADVISORIES=off to disable.',
    }
  }
  if (source === 'mirror') {
    return {
      source,
      sendsInventory: false,
      line: `Advisories: from the mirror at ${baseUrl ?? 'NEAT_ADVISORIES_URL'}; dependency names and versions go only there.`,
    }
  }
  return { source, sendsInventory: false, line: 'Advisories: off (NEAT_ADVISORIES=off); no vulnerability check runs.' }
}

/** advisoryDisclosure for the source this environment selects. */
export function advisoryDisclosureFor(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof advisoryDisclosure> {
  const { source, baseUrl } = advisorySource(env)
  return advisoryDisclosure(source, baseUrl)
}
const TTL_MS = 24 * 60 * 60 * 1000
const BATCH = 1000

export type AdvisorySource = 'mirror' | 'osv' | 'disabled'

export function advisorySource(env: NodeJS.ProcessEnv = process.env): { source: AdvisorySource; baseUrl: string | null } {
  if ((env.NEAT_ADVISORIES ?? '').toLowerCase() === 'off') return { source: 'disabled', baseUrl: null }
  const mirror = env.NEAT_ADVISORIES_URL?.trim()
  if (mirror) return { source: 'mirror', baseUrl: mirror.replace(/\/+$/, '') }
  return { source: 'osv', baseUrl: OSV_API }
}

function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.NEAT_HOME ? path.resolve(env.NEAT_HOME) : path.join(os.homedir(), '.neat')
  return path.join(home, 'advisories')
}

function cacheFile(dir: string, item: Pick<InventoryItem, 'ecosystem' | 'name' | 'version'>): string {
  return path.join(dir, item.ecosystem, `${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}.json`)
}

interface CacheEntry {
  fetchedAt: string
  advisories: Advisory[]
}

async function readCache(file: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as CacheEntry
  } catch {
    return null
  }
}

async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(entry))
  await fs.rename(tmp, file)
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`advisory query failed: ${res.status}`)
  return res.json()
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`advisory fetch failed: ${res.status}`)
  return res.json()
}

// querybatch returns ids only. Each id's full record is fetched once per call.
async function queryIds(
  fetchImpl: typeof fetch,
  baseUrl: string,
  items: InventoryItem[],
): Promise<Map<InventoryItem, string[]>> {
  const out = new Map<InventoryItem, string[]>()
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH)
    let pending = chunk.map((it) => ({ item: it, page_token: undefined as string | undefined }))
    while (pending.length > 0) {
      const body = {
        queries: pending.map(({ item, page_token }) => ({
          package: { ecosystem: item.ecosystem, name: item.name },
          version: item.version,
          ...(page_token ? { page_token } : {}),
        })),
      }
      const res = (await postJson(fetchImpl, `${baseUrl}/v1/querybatch`, body)) as {
        results?: Array<{ vulns?: Array<{ id: string }>; next_page_token?: string }>
      }
      const next: typeof pending = []
      pending.forEach(({ item }, k) => {
        const r = res.results?.[k]
        out.set(item, [...(out.get(item) ?? []), ...(r?.vulns ?? []).map((v) => v.id)])
        if (r?.next_page_token) next.push({ item, page_token: r.next_page_token })
      })
      pending = next
    }
  }
  return out
}

export interface SnapshotResult {
  source: AdvisorySource
  snapshot: AdvisorySnapshot | null
  // Packages served from a cache older than the TTL because a refresh failed.
  stale: number
  errors: string[]
}

/**
 * Build an advisory snapshot for an inventory. Fresh cache entries are used as
 * they are. Missing or stale ones are refreshed from the configured source, and
 * a failed refresh keeps serving the last good entry, counted in `stale`.
 */
export async function loadAdvisorySnapshot(
  inventory: InventoryItem[],
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<SnapshotResult> {
  const env = opts.env ?? process.env
  const { source, baseUrl } = advisorySource(env)
  if (source === 'disabled' || !baseUrl) return { source, snapshot: null, stale: 0, errors: [] }
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const dir = cacheDir(env)

  const unique = new Map<string, InventoryItem>()
  for (const it of inventory) unique.set(`${it.ecosystem}\u0000${it.name}\u0000${it.version}`, it)
  const items = [...unique.values()]

  const collected: Advisory[] = []
  // The snapshot is as old as the oldest data in it.
  const fetchedTimes: string[] = []
  const toRefresh: Array<{ item: InventoryItem; old: CacheEntry | null }> = []
  for (const item of items) {
    const cached = await readCache(cacheFile(dir, item))
    if (cached && now() - Date.parse(cached.fetchedAt) < TTL_MS) {
      collected.push(...cached.advisories)
      fetchedTimes.push(cached.fetchedAt)
    } else toRefresh.push({ item, old: cached })
  }

  let stale = 0
  const errors: string[] = []
  if (toRefresh.length > 0) {
    try {
      const ids = await queryIds(fetchImpl, baseUrl, toRefresh.map((r) => r.item))
      const records = new Map<string, Advisory>()
      for (const id of new Set([...ids.values()].flat())) {
        records.set(id, normalizeOsv((await getJson(fetchImpl, `${baseUrl}/v1/vulns/${encodeURIComponent(id)}`)) as OsvRecord))
      }
      const fetchedAt = new Date(now()).toISOString()
      // The fix-diff is NEAT's own derived data, cached with the advisory it
      // belongs to (advisory-cache.md §4). It's computed once per (advisory,
      // ecosystem, name): a package's two fix-diff releases don't depend on which
      // installed version matched, so versions of one package share the result.
      // buildFixDiff never throws, so a registry miss here can't stale a refresh.
      const fixDiffs = new Map<string, FixDiff | undefined>()
      for (const { item } of toRefresh) {
        const base = (ids.get(item) ?? []).map((id) => records.get(id)!).filter(Boolean)
        const advisories: Advisory[] = []
        for (const adv of base) {
          const key = `${adv.id}\u0000${item.ecosystem}\u0000${item.name}`
          if (!fixDiffs.has(key)) {
            fixDiffs.set(key, await buildFixDiff(adv, { ecosystem: item.ecosystem, name: item.name }, { fetchImpl }))
          }
          const fixDiff = fixDiffs.get(key)
          // A fresh object, so one package's fix-diff never lands on the record
          // shared with another package in the same refresh.
          advisories.push(fixDiff ? { ...adv, fixDiff } : adv)
        }
        collected.push(...advisories)
        fetchedTimes.push(fetchedAt)
        await writeCache(cacheFile(dir, item), { fetchedAt, advisories })
      }
    } catch (err) {
      errors.push((err as Error).message)
      for (const { old } of toRefresh) {
        if (old) {
          collected.push(...old.advisories)
          fetchedTimes.push(old.fetchedAt)
          stale++
        }
      }
    }
  }

  const byId = new Map<string, Advisory>()
  for (const a of collected) byId.set(a.id, a)
  return {
    source,
    snapshot: {
      asOf: fetchedTimes.sort()[0] ?? new Date(now()).toISOString(),
      advisories: foldAliases([...byId.values()]),
    },
    stale,
    errors,
  }
}
