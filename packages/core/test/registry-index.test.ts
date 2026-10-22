import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { daemonsDir, registryPath, type DaemonRecord } from '../src/registry.js'
import {
  machineInventory,
  orphanedMcpFrom,
  readRegistryIndex,
  reapOrphanedMcp,
  registryIndexPath,
  type InventoryProbe,
} from '../src/registry-index.js'
import { mintProjectId } from '../src/project-identity.js'

// #1513 / ADR-273 — the machine index keyed by projectId, and what `neat list`
// reports from it. Every test runs against an isolated NEAT_HOME and temp
// project directories; no real process is signalled except one this test spawns.

const DEAD_PID = 2 ** 30
let home: string
let work: string
let prevHome: string | undefined

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-index-home-'))
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-index-work-')))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(work, { recursive: true, force: true })
})

const probe = (ps = ''): InventoryProbe => ({ isPidAlive: () => false, processes: async () => ps })

async function project(dir: string, opts: { id?: string; name?: string; binding?: object; neatOut?: boolean } = {}): Promise<string> {
  const root = path.join(work, dir)
  await fs.mkdir(root, { recursive: true })
  if (opts.id) {
    await fs.mkdir(path.join(root, '.neat'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.neat', 'project.json'),
      JSON.stringify({ schemaVersion: 1, projectId: opts.id, name: opts.name ?? dir }),
    )
    if (opts.binding) await fs.writeFile(path.join(root, '.neat', 'binding.json'), JSON.stringify(opts.binding))
  }
  if (opts.neatOut) await fs.mkdir(path.join(root, 'neat-out'), { recursive: true })
  return root
}

async function legacyRegistry(rows: Array<{ name: string; path: string }>): Promise<string> {
  const body = JSON.stringify({
    version: 1,
    projects: rows.map((r) => ({ ...r, registeredAt: '2026-10-01T00:00:00.000Z', languages: ['javascript'], status: 'active' })),
  })
  await fs.mkdir(path.dirname(registryPath()), { recursive: true })
  await fs.writeFile(registryPath(), body)
  return body
}

describe('the machine index (registry.json v2)', () => {
  it('migrates projects.json read-only: an identity row, and a legacy row for a path with none', async () => {
    const id = mintProjectId()
    const shop = await project('shop', { id, neatOut: true })
    const old = await project('old', { neatOut: true })
    const before = await legacyRegistry([
      { name: 'shop', path: shop },
      { name: 'old', path: old },
    ])

    const index = await readRegistryIndex(probe())
    expect(index.version).toBe(2)
    expect(index.projects.map((r) => [r.name, r.projectId ?? null, r.legacy ?? false, r.binding])).toEqual([
      ['old', null, true, 'local'],
      ['shop', id, false, 'local'],
    ])
    // Registration time and languages carry over from the old file.
    expect(index.projects.find((r) => r.name === 'shop')).toMatchObject({ registeredAt: '2026-10-01T00:00:00.000Z', languages: ['javascript'] })
    // projects.json is never written.
    expect(await fs.readFile(registryPath(), 'utf8')).toBe(before)
    expect(JSON.parse(await fs.readFile(registryIndexPath(), 'utf8')).version).toBe(2)
  })

  it('rebuilds from disk after registry.json is deleted, and picks up a project inited since', async () => {
    const a = await project('a', { id: mintProjectId() })
    await legacyRegistry([{ name: 'a', path: a }])
    await readRegistryIndex(probe())
    await fs.rm(registryIndexPath())
    const b = await project('b', { id: mintProjectId() })
    await legacyRegistry([
      { name: 'a', path: a },
      { name: 'b', path: b },
    ])
    expect((await readRegistryIndex(probe())).projects.map((r) => r.name)).toEqual(['a', 'b'])
  })

  it('folds in a daemon discovery record as a known path', async () => {
    const id = mintProjectId()
    const svc = await project('svc', { id })
    const record: DaemonRecord = {
      project: 'svc',
      projectPath: svc,
      pid: DEAD_PID,
      status: 'running',
      ports: { rest: 8090, otlp: 4320, web: 6330 },
      startedAt: '2026-10-22T00:00:00.000Z',
      neatVersion: '0.10.9',
    }
    await fs.mkdir(daemonsDir(), { recursive: true })
    await fs.writeFile(path.join(daemonsDir(), 'svc.json'), JSON.stringify(record))
    const [row] = (await readRegistryIndex(probe())).projects
    expect(row).toMatchObject({ projectId: id, path: svc, daemon: { pid: DEAD_PID, port: 8090 } })
  })
})

describe('the inventory `neat list` reports', () => {
  it('splits by binding, and names a shared name with each id instead of failing', async () => {
    const one = mintProjectId()
    const two = mintProjectId()
    const hosted = mintProjectId()
    const a = await project('checkout-a/default', { id: one, name: 'default' })
    const b = await project('checkout-b/default', { id: two, name: 'default' })
    const h = await project('api', { id: hosted, binding: { schemaVersion: 1, binding: 'hosted', org: 'org_01JB' } })
    await legacyRegistry([
      { name: 'default', path: a },
      { name: 'default-2', path: b },
      { name: 'api', path: h },
    ])
    const inv = await machineInventory(probe())
    expect(inv.local.map((r) => r.projectId).sort()).toEqual([one, two].sort())
    expect(inv.hosted).toMatchObject([{ projectId: hosted, org: 'org_01JB' }])
    expect(inv.duplicates).toHaveLength(1)
    expect(inv.duplicates[0]!.name).toBe('default')
    expect(inv.duplicates[0]!.rows.map((r) => r.projectId).sort()).toEqual([one, two].sort())
  })

  it('flags an orphaned neat-out, a gone path and a dead daemon', async () => {
    const orphan = await project('orphan', { neatOut: true })
    const gone = await project('gone', { id: mintProjectId() })
    await legacyRegistry([
      { name: 'orphan', path: orphan },
      { name: 'gone', path: gone },
    ])
    await readRegistryIndex(probe())
    await fs.rm(gone, { recursive: true })
    const inv = await machineInventory(probe())
    expect(inv.orphans).toEqual([orphan])
    expect(inv.stale.map((r) => r.name)).toEqual(['gone'])
    // A gone path keeps the id it had.
    expect(inv.stale[0]!.projectId).toMatch(/^prj_/)
  })

  it('finds MCP servers whose parent died, and only those', () => {
    const ps = [
      '  101     1 node /usr/local/lib/node_modules/@neat.is/mcp/dist/index.cjs',
      '  102  4242 node /usr/local/lib/node_modules/@neat.is/mcp/dist/index.cjs',
      '  103     1 node /Users/me/neat/packages/mcp/dist/index.cjs',
      '  104     1 node some-other-server.js',
    ].join('\n')
    expect(orphanedMcpFrom(ps).map((p) => p.pid)).toEqual([101, 103])
  })

  it('reports orphaned MCP servers without stopping them; reaping is separate', async () => {
    const inv = await machineInventory(probe('  77 1 node /x/@neat.is/mcp/dist/index.cjs'))
    expect(inv.orphanedMcp).toEqual([{ pid: 77, command: 'node /x/@neat.is/mcp/dist/index.cjs' }])

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, sig) => r(sig)))
    expect(reapOrphanedMcp([{ pid: child.pid!, command: 'node' }])).toEqual([child.pid])
    expect(await exited).toBe('SIGTERM')
    // An already-gone pid is skipped, not an error.
    expect(reapOrphanedMcp([{ pid: DEAD_PID, command: 'node' }])).toEqual([])
  })
})
