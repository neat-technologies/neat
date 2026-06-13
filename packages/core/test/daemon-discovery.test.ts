import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  addProject,
  daemonsDir,
  discoverDaemons,
  findDaemonByProject,
  listMachineProjects,
  removeDaemonRecord,
  type DaemonRecord,
  type DiscoveryProbe,
} from '../src/registry.js'

// #366 / ADR-096 §6 — machine-wide discovery reads the lock-free
// `~/.neat/daemons/` directory and reconciles liveness. These tests run against
// an isolated NEAT_HOME tmpdir; the real ~/.neat and its live daemon are never
// touched. No real PIDs are signalled — liveness goes through an injected probe.

let home: string
let prevHome: string | undefined

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-discovery-home-'))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
})

// Write one discovery file the way a daemon would (keystone #508): a copy of
// its neat-out/daemon.json under ~/.neat/daemons/<project>.json.
async function writeDaemonFile(record: DaemonRecord): Promise<string> {
  const dir = daemonsDir()
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${record.project}.json`)
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return file
}

function record(over: Partial<DaemonRecord> = {}): DaemonRecord {
  return {
    project: 'alpha',
    projectPath: '/tmp/alpha',
    pid: 4242,
    status: 'running',
    ports: { rest: 8080, otlp: 4318, web: 6328 },
    startedAt: '2026-06-13T00:00:00.000Z',
    neatVersion: '0.4.17',
    ...over,
  }
}

// A probe that treats a fixed PID set as alive — no real process signalling.
function probe(alivePids: number[]): DiscoveryProbe {
  const alive = new Set(alivePids)
  return { isPidAlive: (pid) => alive.has(pid) }
}

describe('discoverDaemons', () => {
  it('returns an empty list when no daemons directory exists', async () => {
    expect(await discoverDaemons(probe([]))).toEqual([])
  })

  it('reports a running daemon as live when its pid is alive', async () => {
    await writeDaemonFile(record({ project: 'alpha', pid: 4242 }))
    const found = await discoverDaemons(probe([4242]))
    expect(found).toHaveLength(1)
    expect(found[0]!.record.project).toBe('alpha')
    expect(found[0]!.live).toBe(true)
    expect(found[0]!.record.ports).toEqual({ rest: 8080, otlp: 4318, web: 6328 })
  })

  it('reports a running record whose pid is dead as not live (a ghost daemon)', async () => {
    await writeDaemonFile(record({ project: 'alpha', pid: 9999, status: 'running' }))
    const found = await discoverDaemons(probe([])) // 9999 not alive
    expect(found).toHaveLength(1)
    expect(found[0]!.live).toBe(false)
  })

  it('reports a status=stopped record as not live even if the pid happens to be alive', async () => {
    await writeDaemonFile(record({ project: 'alpha', pid: 4242, status: 'stopped' }))
    const found = await discoverDaemons(probe([4242]))
    expect(found[0]!.live).toBe(false)
  })

  it('skips malformed and non-json files without failing', async () => {
    const dir = daemonsDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8')
    await fs.writeFile(path.join(dir, 'partial.json'), JSON.stringify({ project: 'x' }), 'utf8')
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignore me', 'utf8')
    await writeDaemonFile(record({ project: 'good', pid: 4242 }))

    const found = await discoverDaemons(probe([4242]))
    expect(found.map((d) => d.record.project)).toEqual(['good'])
  })

  it('sorts records by project name', async () => {
    await writeDaemonFile(record({ project: 'zeta', pid: 1 }))
    await writeDaemonFile(record({ project: 'alpha', pid: 2 }))
    const found = await discoverDaemons(probe([1, 2]))
    expect(found.map((d) => d.record.project)).toEqual(['alpha', 'zeta'])
  })
})

describe('findDaemonByProject', () => {
  it('finds a daemon by project name with its liveness', async () => {
    await writeDaemonFile(record({ project: 'alpha', pid: 4242 }))
    const d = await findDaemonByProject('alpha', probe([4242]))
    expect(d?.record.project).toBe('alpha')
    expect(d?.live).toBe(true)
    expect(d?.source.endsWith('alpha.json')).toBe(true)
  })

  it('returns undefined for an unknown project', async () => {
    await writeDaemonFile(record({ project: 'alpha', pid: 4242 }))
    expect(await findDaemonByProject('nope', probe([4242]))).toBeUndefined()
  })
})

describe('removeDaemonRecord', () => {
  it('removes a discovery file and is idempotent', async () => {
    const file = await writeDaemonFile(record({ project: 'alpha', pid: 4242 }))
    await removeDaemonRecord(file)
    await expect(fs.access(file)).rejects.toThrow()
    // Already gone — still resolves.
    await expect(removeDaemonRecord(file)).resolves.toBeUndefined()
  })
})

describe('listMachineProjects — discovery + legacy migration fold (ADR-096 §8)', () => {
  it('renders a running discovery daemon as running with its ports', async () => {
    await writeDaemonFile(record({ project: 'alpha', projectPath: '/tmp/alpha', pid: 4242 }))
    const rows = await listMachineProjects(probe([4242]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      project: 'alpha',
      state: 'running',
      ports: { rest: 8080, otlp: 4318, web: 6328 },
      pid: 4242,
    })
  })

  it('renders a dead discovery daemon as stopped', async () => {
    await writeDaemonFile(record({ project: 'alpha', pid: 9999, status: 'running' }))
    const rows = await listMachineProjects(probe([]))
    expect(rows[0]!.state).toBe('stopped')
  })

  it('folds a legacy registry entry with no daemon file as a registered row', async () => {
    // A pre-#508 install: registered in projects.json, no daemon file yet.
    await addProject({ name: 'legacy-proj', path: home, status: 'active' })
    const rows = await listMachineProjects(probe([]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      project: 'legacy-proj',
      state: 'registered',
      registryStatus: 'active',
    })
    expect(rows[0]!.ports).toBeUndefined()
  })

  it('collapses a registry entry and its daemon record (same path) to one row', async () => {
    // The realpath-normalized home is what the registry stores; the daemon
    // record points at the same path, so the two must collapse.
    const real = await fs.realpath(home)
    await addProject({ name: 'alpha', path: home, status: 'active' })
    await writeDaemonFile(record({ project: 'alpha', projectPath: real, pid: 4242 }))

    const rows = await listMachineProjects(probe([4242]))
    expect(rows).toHaveLength(1)
    // Discovery wins — the row is running with ports, not a registered stub.
    expect(rows[0]!.state).toBe('running')
    expect(rows[0]!.ports).toBeDefined()
  })

  it('returns an empty list when nothing is running and nothing is registered', async () => {
    expect(await listMachineProjects(probe([]))).toEqual([])
  })
})
