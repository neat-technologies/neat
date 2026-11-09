import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { runDoctorChecks, runDoctorCommand, type DoctorCheck } from '../src/doctor-cli.js'
import type { DaemonRecord } from '../src/daemon.js'
import { ensureProjectIdentity } from '../src/project-identity.js'
import { upsertProfile } from '../src/profiles.js'

// `neat doctor` — a read-only preflight (cli-surface.md §neat doctor). Every
// case runs against injected deps (cwd / env / fetch / record reader / node
// version), so the checks are exercised without a live daemon. The invariants:
// it never throws even when the daemon is unreachable, exit is 0 only when every
// check passes, and a down daemon is a reported finding (never exit 3).

const RECORD: DaemonRecord = {
  project: 'demo',
  projectPath: '/tmp/demo',
  pid: 4321,
  status: 'running',
  ports: { rest: 8080, otlp: 4318, web: 6328 },
  startedAt: '2026-08-25T00:00:00.000Z',
  neatVersion: '0.9.4',
}

const okHealth = () =>
  Promise.resolve(
    new Response(JSON.stringify({ ok: true, project: 'demo', projects: [{ name: 'demo', nodeCount: 5, edgeCount: 3 }] }), {
      status: 200,
    }),
  )

function byName(checks: DoctorCheck[], name: string): DoctorCheck {
  const c = checks.find((x) => x.name === name)
  if (!c) throw new Error(`no check named ${name}`)
  return c
}

async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-doctor-'))
  return fs.realpath(dir)
}

// NEAT_LEGACY_ROUTING=1 keeps the pre-ADR-273 probe (project-identity.md §7);
// these cases pin that rollback path. The resolver-backed path is below.
const LEGACY = { NEAT_LEGACY_ROUTING: '1' }

describe('neat doctor (legacy routing)', () => {
  it('reports all-clear when Node, project, and daemon are healthy', async () => {
    const checks = await runDoctorChecks({
      nodeVersion: '20.11.0',
      env: LEGACY,
      readRecord: async () => RECORD,
      fetchImpl: okHealth as unknown as typeof fetch,
    })
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(byName(checks, 'daemon').detail).toContain('up at http://localhost:8080')
    expect(byName(checks, 'daemon').detail).toContain('5 nodes / 3 edges')
    expect(byName(checks, 'project').detail).toContain('"demo"')
  })

  it('exits 0 and prints "all good" when every check passes', async () => {
    const lines: string[] = []
    const code = await runDoctorCommand([], {
      nodeVersion: '20.11.0',
      env: LEGACY,
      readRecord: async () => RECORD,
      fetchImpl: okHealth as unknown as typeof fetch,
      out: (l) => lines.push(l),
    })
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('all good.')
  })

  it('reports the daemon as down without throwing, and exits 1 (never 3)', async () => {
    const lines: string[] = []
    const code = await runDoctorCommand([], {
      nodeVersion: '20.11.0',
      env: LEGACY,
      readRecord: async () => RECORD,
      // A refused connection / timeout surfaces as a rejected fetch.
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
      out: (l) => lines.push(l),
    })
    expect(code).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('down — nothing answering at http://localhost:8080')
    expect(out).toContain('fix:')
  })

  it('flags a directory with no NEAT project and points at `neat .`', async () => {
    const empty = await makeTmp()
    const checks = await runDoctorChecks({
      cwd: empty,
      nodeVersion: '20.11.0',
      env: LEGACY,
      readRecord: async () => null,
      fetchImpl: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    })
    const project = byName(checks, 'project')
    expect(project.ok).toBe(false)
    expect(project.fix).toContain('neat .')
  })

  it('treats a set-up-but-stopped project (neat-out/, no record) as ok', async () => {
    const root = await makeTmp()
    await fs.mkdir(path.join(root, 'neat-out'))
    const checks = await runDoctorChecks({
      cwd: root,
      nodeVersion: '20.11.0',
      env: LEGACY,
      readRecord: async () => null,
      fetchImpl: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    })
    expect(byName(checks, 'project').ok).toBe(true)
  })

  it('fails the node check below the v20 floor', async () => {
    const checks = await runDoctorChecks({
      nodeVersion: '18.19.1',
      env: LEGACY,
      readRecord: async () => RECORD,
      fetchImpl: okHealth as unknown as typeof fetch,
    })
    expect(byName(checks, 'node').ok).toBe(false)
    expect(byName(checks, 'node').fix).toContain('Node')
  })

  it('surfaces an auth rejection as an actionable daemon finding', async () => {
    const checks = await runDoctorChecks({
      nodeVersion: '20.11.0',
      env: LEGACY,
      readRecord: async () => RECORD,
      fetchImpl: (() => Promise.resolve(new Response('', { status: 401 }))) as unknown as typeof fetch,
    })
    const daemon = byName(checks, 'daemon')
    expect(daemon.ok).toBe(false)
    expect(daemon.fix).toContain('NEAT_AUTH_TOKEN')
  })

  it('prefers an explicit NEAT_API_URL over the recorded port', async () => {
    let probed = ''
    const checks = await runDoctorChecks({
      nodeVersion: '20.11.0',
      env: { ...LEGACY, NEAT_API_URL: 'http://localhost:9999' },
      readRecord: async () => RECORD,
      fetchImpl: ((url: string) => {
        probed ||= url
        return okHealth()
      }) as unknown as typeof fetch,
    })
    expect(probed).toBe('http://localhost:9999/health')
    expect(byName(checks, 'daemon').detail).toContain('http://localhost:9999')
  })

  it('emits the three-field JSON shape under --json', async () => {
    const lines: string[] = []
    const code = await runDoctorCommand(['--json'], {
      nodeVersion: '20.11.0',
      env: LEGACY,
      readRecord: async () => RECORD,
      fetchImpl: okHealth as unknown as typeof fetch,
      out: (l) => lines.push(l),
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(lines.join('\n')) as { ok: boolean; checks: DoctorCheck[] }
    expect(parsed.ok).toBe(true)
    expect(parsed.checks.map((c) => c.name)).toEqual(['node', 'project', 'daemon'])
  })

  it('rejects an unknown argument with exit 2', async () => {
    const lines: string[] = []
    const code = await runDoctorCommand(['--nope'], { out: (l) => lines.push(l) })
    expect(code).toBe(2)
    expect(lines.join('\n')).toContain('unknown argument')
  })
})

// ADR-273 / WO-0.8 — doctor checks the project and daemon a query from this
// directory would use (the shared resolver), never a loopback guess. Before, a
// hosted-bound project reported "all good" for whatever answered on :8080.
describe('neat doctor (project resolution)', () => {
  let home: string
  let work: string
  let prevHome: string | undefined
  beforeEach(async () => {
    home = await makeTmp()
    work = await makeTmp()
    prevHome = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    await fs.mkdir(path.join(home, 'daemons'))
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.NEAT_HOME
    else process.env.NEAT_HOME = prevHome
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(work, { recursive: true, force: true })
  })

  async function project(name: string): Promise<{ root: string; projectId: string }> {
    const root = path.join(work, name)
    await fs.mkdir(root, { recursive: true })
    const { identity } = await ensureProjectIdentity(root, { name })
    return { root, projectId: identity.projectId }
  }
  async function daemon(p: { root: string; projectId: string }, name: string, rest: number): Promise<void> {
    await fs.writeFile(
      path.join(home, 'daemons', `${p.projectId}.json`),
      JSON.stringify({ project: name, projectId: p.projectId, projectPath: p.root, pid: process.pid, status: 'running', ports: { rest, otlp: rest + 1, web: rest + 2 }, startedAt: '2026-10-22T00:00:00.000Z', neatVersion: '0.10.11' }),
    )
  }
  const probe = (cwd: string) => {
    const probed: string[] = []
    const run = runDoctorChecks({
      cwd,
      nodeVersion: '20.11.0',
      env: {},
      fetchImpl: ((url: string, init?: RequestInit) => {
        probed.push(`${url} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? ''}`.trim())
        return okHealth()
      }) as unknown as typeof fetch,
    })
    return { run, probed }
  }

  it('from a subdirectory, finds the project and probes its own daemon', async () => {
    const p = await project('repoA')
    await daemon(p, 'repoA', 18090)
    const deep = path.join(p.root, 'src', 'deep')
    await fs.mkdir(deep, { recursive: true })
    const { run, probed } = probe(deep)
    const checks = await run
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(byName(checks, 'project').detail).toBe(`project=repoA (${p.projectId}) · binding=local · daemon=http://localhost:18090`)
    expect(probed[0]).toBe('http://localhost:18090/health')
  })

  it('a hosted-bound project is probed at its hosted endpoint with its bearer, never loopback', async () => {
    const h = await project('repoH')
    await fs.writeFile(path.join(h.root, '.neat/binding.json'), JSON.stringify({ schemaVersion: 1, binding: 'hosted', org: 'org_acme' }))
    await upsertProfile({ name: 'hosted', endpoint: 'https://tenant.example', authToken: 't0k' }, { makeActive: true })
    const { run, probed } = probe(h.root)
    const checks = await run
    expect(probed[0]).toBe('https://tenant.example/health Bearer t0k')
    expect(probed.some((u) => u.includes('localhost'))).toBe(false)
    expect(byName(checks, 'daemon').detail).toContain('hosted@org_acme')
  })

  it('a project whose daemon is down fails the daemon check with neat up, and probes nothing', async () => {
    const p = await project('quiet')
    const { run, probed } = probe(p.root)
    const checks = await run
    expect(byName(checks, 'project').ok).toBe(true)
    expect(byName(checks, 'daemon')).toMatchObject({ ok: false, fix: 'start it: `neat up`' })
    expect(byName(checks, 'daemon').detail).toMatch(/daemon isn't running/)
    expect(probed).toEqual([])
  })

  it('outside any project it fails the project check and probes nothing', async () => {
    const { run, probed } = probe(work)
    const checks = await run
    expect(byName(checks, 'project')).toMatchObject({ ok: false })
    expect(byName(checks, 'project').detail).toMatch(/no NEAT project here/)
    expect(checks.map((c) => c.name)).toEqual(['node', 'project'])
    expect(probed).toEqual([])
  })
})
