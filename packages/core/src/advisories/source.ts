import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { foldAliases, normalizeOsv, type Advisory, type OsvRecord } from './normalize.js'
import type { AdvisorySnapshot, InventoryItem } from './match.js'
import { buildFixDiff, FixDiffSession } from './release-fetch.js'
import type { FixDiff } from './fixdiff.js'

// How many advisory records, or packages' fix-diffs, a refresh works on at once.
// Enough to overlap registry round trips; small enough that only a few packages'
// extracted releases are held in memory together.
const POOL = 4

async function inPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  // On the first failure no new item starts, so a failed refresh stops as the
  // serial loop did; items already in flight finish before this rejects.
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      try {
        await work(items[next++]!)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(size, items.length) }, worker))
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (rejected) throw rejected.reason
}

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
  // Set when this entry's fix-diffs weren't built because nothing imported the
  // package at the time (advisory-cache.md §4). Absent means they were.
  fixDiffsSkipped?: true
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

// One inventory item's cache entry to write: its advisories, and whether to
// build their fix-diffs. `fallback` is what to serve if writing fails.
interface CacheJob {
  item: InventoryItem
  base: Advisory[]
  fetchedAt: string
  diff: boolean
  fallback: { advisories: Advisory[]; fetchedAt: string; stale: boolean } | null
}

/**
 * Write each job's cache entry, with fix-diffs where the job asks for them.
 *
 * The fix-diff is NEAT's own derived data, cached with the advisory it belongs
 * to (advisory-cache.md §4). It's computed once per (advisory, ecosystem, name):
 * a package's two fix-diff releases don't depend on which installed version
 * matched, so versions of one package share the result. A package's advisories
 * share one FixDiffSession, so each release is fetched and extracted once
 * however many advisories it fixes or precedes. Packages are worked a few at a
 * time; each item's entry is written as soon as its package is done, so an
 * interrupted refresh keeps what it finished. buildFixDiff never throws, so a
 * registry miss can't stale a refresh.
 */
async function writeEntries(dir: string, jobs: CacheJob[], fetchImpl: typeof fetch): Promise<Map<InventoryItem, Advisory[]>> {
  const byPackage = new Map<string, CacheJob[]>()
  for (const job of jobs) {
    const k = `${job.item.ecosystem}\u0000${job.item.name}`
    byPackage.set(k, [...(byPackage.get(k) ?? []), job])
  }
  const results = new Map<InventoryItem, Advisory[]>()
  await inPool([...byPackage.values()], POOL, async (pkgJobs) => {
    const { ecosystem, name } = pkgJobs[0]!.item
    const session = pkgJobs.some((j) => j.diff) ? new FixDiffSession(ecosystem, name, fetchImpl) : null
    const fixDiffs = new Map<string, FixDiff | undefined>()
    for (const job of pkgJobs) {
      const advisories: Advisory[] = []
      for (const adv of job.base) {
        if (!job.diff || !session) {
          advisories.push(adv)
          continue
        }
        if (!fixDiffs.has(adv.id)) fixDiffs.set(adv.id, await buildFixDiff(adv, { ecosystem, name }, { fetchImpl, session }))
        const fixDiff = fixDiffs.get(adv.id)
        // A fresh object, so one package's fix-diff never lands on the record
        // shared with another package in the same refresh.
        advisories.push(fixDiff ? { ...adv, fixDiff } : adv)
      }
      results.set(job.item, advisories)
      await writeCache(cacheFile(dir, job.item), {
        fetchedAt: job.fetchedAt,
        advisories,
        ...(job.diff ? {} : { fixDiffsSkipped: true as const }),
      })
    }
  })
  return results
}

/**
 * Build an advisory snapshot for an inventory. Fresh cache entries are used as
 * they are. Missing or stale ones are refreshed from the configured source, and
 * a failed refresh keeps serving the last good entry, counted in `stale`.
 *
 * `fixDiffFor` says which inventory items get fix-diffs (advisory-cache.md §4):
 * callers pass "some service's own code imports it", since a finding that stops
 * at the lockfile has no use for one. Left out, every item gets them.
 */
export async function loadAdvisorySnapshot(
  inventory: InventoryItem[],
  opts: {
    fetchImpl?: typeof fetch
    env?: NodeJS.ProcessEnv
    now?: () => number
    fixDiffFor?: (item: InventoryItem) => boolean
  } = {},
): Promise<SnapshotResult> {
  const env = opts.env ?? process.env
  const { source, baseUrl } = advisorySource(env)
  if (source === 'disabled' || !baseUrl) return { source, snapshot: null, stale: 0, errors: [] }
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const wantsFixDiff = opts.fixDiffFor ?? (() => true)
  const dir = cacheDir(env)

  const unique = new Map<string, InventoryItem>()
  for (const it of inventory) unique.set(`${it.ecosystem}\u0000${it.name}\u0000${it.version}`, it)
  const items = [...unique.values()]

  const collected: Advisory[] = []
  // The snapshot is as old as the oldest data in it.
  const fetchedTimes: string[] = []
  const toRefresh: Array<{ item: InventoryItem; old: CacheEntry | null }> = []
  // Fresh entries written without fix-diffs for a package that's imported now:
  // the advisories stand, only the fix-diffs are built.
  const toDiff: Array<{ item: InventoryItem; entry: CacheEntry }> = []
  for (const item of items) {
    const cached = await readCache(cacheFile(dir, item))
    if (cached && now() - Date.parse(cached.fetchedAt) < TTL_MS) {
      if (cached.fixDiffsSkipped && wantsFixDiff(item)) toDiff.push({ item, entry: cached })
      else {
        collected.push(...cached.advisories)
        fetchedTimes.push(cached.fetchedAt)
      }
    } else toRefresh.push({ item, old: cached })
  }

  let stale = 0
  const errors: string[] = []
  const jobs: CacheJob[] = toDiff.map(({ item, entry }) => ({
    item,
    base: entry.advisories,
    fetchedAt: entry.fetchedAt,
    diff: true,
    fallback: { advisories: entry.advisories, fetchedAt: entry.fetchedAt, stale: false },
  }))
  if (toRefresh.length > 0) {
    try {
      const ids = await queryIds(fetchImpl, baseUrl, toRefresh.map((r) => r.item))
      const records = new Map<string, Advisory>()
      await inPool([...new Set([...ids.values()].flat())], POOL, async (id) => {
        records.set(id, normalizeOsv((await getJson(fetchImpl, `${baseUrl}/v1/vulns/${encodeURIComponent(id)}`)) as OsvRecord))
      })
      const fetchedAt = new Date(now()).toISOString()
      for (const { item, old } of toRefresh) {
        jobs.push({
          item,
          base: (ids.get(item) ?? []).map((id) => records.get(id)!).filter(Boolean),
          fetchedAt,
          diff: wantsFixDiff(item),
          fallback: old ? { advisories: old.advisories, fetchedAt: old.fetchedAt, stale: true } : null,
        })
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

  if (jobs.length > 0) {
    try {
      const results = await writeEntries(dir, jobs, fetchImpl)
      // Assembled in inventory order, not completion order, so the snapshot is
      // the same however the pool interleaved.
      for (const job of jobs) {
        collected.push(...(results.get(job.item) ?? []))
        fetchedTimes.push(job.fetchedAt)
      }
    } catch (err) {
      errors.push((err as Error).message)
      for (const { fallback } of jobs) {
        if (fallback) {
          collected.push(...fallback.advisories)
          fetchedTimes.push(fallback.fetchedAt)
          if (fallback.stale) stale++
        }
      }
    }
  }

  const byId = new Map<string, Advisory>()
  // One advisory can cover several packages. A record without a fix-diff never
  // replaces one with it, so an unimported package can't hide an imported one's.
  for (const a of collected) if (!(byId.get(a.id)?.fixDiff && !a.fixDiff)) byId.set(a.id, a)
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
