import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  addProject,
  listProjects,
  normalizeProjectPath,
  pruneRegistry,
  readRegistry,
  registryPath,
  touchLastSeen,
  DEFAULT_PRUNE_TTL_MS,
  type PathStatus,
} from '../src/registry.js'

// #463 — the registry used to accumulate entries whose `path` was gone from
// disk: smoke runs and tmp-dir demos left zombie rows the daemon logged an
// ENOENT warning for on every startup, forever, and `/api/health` reported as
// permanent `broken`. These tests pin the prune behaviour. Every one runs
// against an ISOLATED NEAT_HOME tmpdir — the real ~/.neat is never touched.

let home: string
let prevHome: string | undefined
// A real, existing directory used as a stand-in "live" project path. Its
// registry-stored form is the realpath-normalized version (macOS resolves
// /var/folders → /private/var/folders), so fake-stat probes key on `liveDir`.
let liveDir: string

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-prune-home-'))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
  liveDir = await normalizeProjectPath(home)
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  delete process.env.NEAT_REGISTRY_PRUNE_TTL_MS
  await fs.rm(home, { recursive: true, force: true })
})

const DAY_MS = 24 * 60 * 60 * 1000

// A stat probe that reports each path by its name. Lets us drive the
// gone/present/unknown branches deterministically without a real filesystem.
function fakeStat(byName: Record<string, PathStatus>): (p: string) => Promise<PathStatus> {
  return async (p) => byName[p] ?? 'gone'
}

describe('pruneRegistry — auto-prune (TTL-gated)', () => {
  it('removes a gone-path entry whose lastSeenAt is older than the TTL', async () => {
    await addProject({ name: 'live', path: home }) // path exists (the home dir)
    await addProject({ name: 'dead', path: '/private/tmp/neatd-project-dead-Xx' })

    // Backdate the dead entry past the TTL.
    const stale = new Date(Date.now() - (DEFAULT_PRUNE_TTL_MS + DAY_MS)).toISOString()
    await touchLastSeen('dead', stale)

    const removed = await pruneRegistry({
      statPath: fakeStat({ [liveDir]: 'present' }), // every other path → 'gone'
    })

    expect(removed.map((p) => p.name)).toEqual(['dead'])
    const names = (await listProjects()).map((p) => p.name)
    expect(names).toEqual(['live'])
  })

  it('keeps a fresh gone-path entry (recent lastSeenAt) — daemon still marks it broken', async () => {
    await addProject({ name: 'recent', path: '/private/tmp/neatd-project-recent-Yy' })
    // addProject sets registeredAt = now; lastSeenAt undefined → falls back to
    // registeredAt, which is fresh. Should survive auto-prune.

    const removed = await pruneRegistry({ statPath: fakeStat({}) }) // all gone
    expect(removed).toEqual([])
    expect((await listProjects()).map((p) => p.name)).toEqual(['recent'])
  })

  it('NEAT_REGISTRY_PRUNE_TTL_MS overrides the default TTL', async () => {
    await addProject({ name: 'dead', path: '/private/tmp/gone-zz' })
    // 1h old — under the 7-day default, but over a 1-minute override.
    await touchLastSeen('dead', new Date(Date.now() - 60 * 60 * 1000).toISOString())

    // Default TTL: kept.
    expect(await pruneRegistry({ statPath: fakeStat({}) })).toEqual([])

    process.env.NEAT_REGISTRY_PRUNE_TTL_MS = String(60_000)
    const removed = await pruneRegistry({ statPath: fakeStat({}) })
    expect(removed.map((p) => p.name)).toEqual(['dead'])
  })
})

describe('neat prune — one-shot (ttlMs: 0)', () => {
  it('removes every gone-path entry immediately regardless of age, keeps live ones', async () => {
    await addProject({ name: 'live', path: home })
    await addProject({ name: 'recoverable', path: '/private/tmp/neatd-project-recoverable-VgHei1' })
    await addProject({ name: 'brief-demo', path: '/private/tmp/brief-demo' })
    // brief-demo was just registered (fresh) — explicit prune drops it anyway.

    const removed = await pruneRegistry({
      ttlMs: 0,
      statPath: fakeStat({ [liveDir]: 'present' }),
    })

    expect(removed.map((p) => p.name).sort()).toEqual(['brief-demo', 'recoverable'])
    expect((await listProjects()).map((p) => p.name)).toEqual(['live'])
  })

  it('removes nothing when every registered path exists', async () => {
    await addProject({ name: 'a', path: home })
    const removed = await pruneRegistry({ ttlMs: 0, statPath: fakeStat({ [liveDir]: 'present' }) })
    expect(removed).toEqual([])
    expect((await listProjects()).map((p) => p.name)).toEqual(['a'])
  })
})

describe('pruneRegistry — conservative on transient errors', () => {
  it('leaves an entry intact on a non-ENOENT stat error (EACCES / EBUSY)', async () => {
    await addProject({ name: 'unreachable', path: '/mnt/unmounted/project' })
    await touchLastSeen('unreachable', new Date(0).toISOString()) // ancient — would prune if gone

    // 'unknown' models EACCES/EBUSY/unmounted: not a definite ENOENT.
    const autoRemoved = await pruneRegistry({
      statPath: fakeStat({ '/mnt/unmounted/project': 'unknown' }),
    })
    expect(autoRemoved).toEqual([])

    // Even explicit `neat prune` (ttlMs: 0) must not drop it — it isn't dead.
    const forceRemoved = await pruneRegistry({
      ttlMs: 0,
      statPath: fakeStat({ '/mnt/unmounted/project': 'unknown' }),
    })
    expect(forceRemoved).toEqual([])
    expect((await listProjects()).map((p) => p.name)).toEqual(['unreachable'])
  })

  it('never prunes an active project whose path still exists', async () => {
    await addProject({ name: 'live', path: home })
    const removed = await pruneRegistry({ ttlMs: 0, statPath: fakeStat({ [liveDir]: 'present' }) })
    expect(removed).toEqual([])
  })
})

describe('pruneRegistry — atomicity invariant', () => {
  it('leaves a well-formed registry file after prune (re-parseable, version 1)', async () => {
    await addProject({ name: 'live', path: home })
    await addProject({ name: 'dead', path: '/private/tmp/gone-aa' })

    await pruneRegistry({ ttlMs: 0, statPath: fakeStat({ [liveDir]: 'present' }) })

    // Raw bytes parse cleanly and trail with a newline (writeAtomically shape).
    const raw = await fs.readFile(registryPath(), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)

    // And the schema-validated read agrees.
    const reg = await readRegistry()
    expect(reg.version).toBe(1)
    expect(reg.projects.map((p) => p.name)).toEqual(['live'])
  })

  it('integration: prunes a real gone path, keeps a real existing one', async () => {
    const existing = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-prune-proj-'))
    const gone = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-prune-gone-'))
    try {
      await addProject({ name: 'keeper', path: existing })
      await addProject({ name: 'ghost', path: gone })
      await fs.rm(gone, { recursive: true, force: true }) // path is now ENOENT for real

      const removed = await pruneRegistry({ ttlMs: 0 }) // real stat
      expect(removed.map((p) => p.name)).toEqual(['ghost'])
      expect((await listProjects()).map((p) => p.name)).toEqual(['keeper'])
    } finally {
      await fs.rm(existing, { recursive: true, force: true })
    }
  })
})

describe('DEFAULT_PRUNE_TTL_MS', () => {
  it('defaults to 7 days', () => {
    expect(DEFAULT_PRUNE_TTL_MS).toBe(7 * DAY_MS)
  })
})
