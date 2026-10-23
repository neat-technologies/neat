import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ensureProjectIdentity } from '../src/project-identity.js'
import { addProject } from '../src/registry.js'
import { upsertProfile } from '../src/profiles.js'
import { resolveProjectTarget, TargetResolutionError, UnknownProfileError } from '../src/project-resolve.js'

// ADR-273 / WO-0.2 — one resolution for every surface (project-identity.md §3–§4):
// pin → --project → the nearest .neat/project.json → a legacy registration with a
// notice → an error. Routed by the project's binding; the logged-in profile never
// moves a local project (#11), and nothing falls back to loopback.

let home: string
let work: string
const saved: Record<string, string | undefined> = {}
const KEYS = ['NEAT_HOME', 'NEAT_API_URL', 'NEAT_CORE_URL', 'NEAT_PROFILE', 'NEAT_PROJECT', 'NEAT_AUTH_TOKEN', 'NEAT_LEGACY_ROUTING']

beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-resolve-home-'))
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-resolve-work-'))
  process.env.NEAT_HOME = home
  mkdirSync(path.join(home, 'daemons'))
})
afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(work, { recursive: true, force: true })
})

async function project(name: string, opts: { register?: boolean } = {}): Promise<{ root: string; projectId: string }> {
  const root = path.join(work, name)
  await fs.mkdir(root, { recursive: true })
  const { identity } = await ensureProjectIdentity(root, { name })
  if (opts.register !== false) await addProject({ name: `${name}-${identity.projectId.slice(-4)}`, path: root, languages: [], status: 'active' })
  return { root, projectId: identity.projectId }
}

function daemon(p: { root: string; projectId?: string }, name: string, rest: number): void {
  writeFileSync(
    path.join(home, 'daemons', `${p.projectId ?? name}.json`),
    JSON.stringify({
      project: name,
      ...(p.projectId ? { projectId: p.projectId } : {}),
      projectPath: p.root,
      pid: process.pid,
      status: 'running',
      ports: { rest, otlp: rest + 1, web: rest + 2 },
      startedAt: '2026-10-22T00:00:00.000Z',
      neatVersion: '0.10.11',
    }),
  )
}

describe('project-scoped resolution (ADR-273)', () => {
  it('the nearest .neat/project.json wins, routed to the daemon carrying its projectId', async () => {
    const p = await project('newdryve')
    daemon(p, 'newdryve', 18080)
    const deep = path.join(p.root, 'apps', 'api')
    await fs.mkdir(deep, { recursive: true })
    const t = await resolveProjectTarget({ cwd: deep })
    expect(t).toMatchObject({ endpoint: 'http://localhost:18080', source: 'cwd', daemonProject: 'newdryve' })
    expect(t.line).toBe(`project=newdryve (${p.projectId}) · binding=local · daemon=http://localhost:18080`)
    expect(t.notices).toEqual([])
  })

  it('a logged-in active profile does not move a local project (#11)', async () => {
    const p = await project('newdryve')
    daemon(p, 'newdryve', 18080)
    await upsertProfile({ name: 'hosted', endpoint: 'https://tenant.neat.is', authToken: 't0k' }, { makeActive: true })
    const t = await resolveProjectTarget({ cwd: p.root })
    expect(t.endpoint).toBe('http://localhost:18080')
    expect(t.authToken).toBeUndefined()
  })

  it('a hosted binding goes to the account endpoint with its bearer', async () => {
    const p = await project('shop')
    await fs.writeFile(path.join(p.root, '.neat/binding.json'), JSON.stringify({ schemaVersion: 1, binding: 'hosted', org: 'org_acme' }))
    await upsertProfile({ name: 'hosted', endpoint: 'https://tenant.neat.is', authToken: 't0k' }, { makeActive: true })
    const t = await resolveProjectTarget({ cwd: p.root })
    expect(t).toMatchObject({ endpoint: 'https://tenant.neat.is', authToken: 't0k' })
    expect(t.line).toBe(`project=shop (${p.projectId}) · binding=hosted@org_acme · daemon=https://tenant.neat.is`)
  })

  it('a hosted binding with no login is an error naming neat login', async () => {
    const p = await project('shop')
    await fs.writeFile(path.join(p.root, '.neat/binding.json'), JSON.stringify({ schemaVersion: 1, binding: 'hosted', org: 'org_acme' }))
    await expect(resolveProjectTarget({ cwd: p.root })).rejects.toThrow(/hosted \(in org_acme\).*neat login/)
  })

  it('--project resolves by id or by name; a shared name lists the ids; an unknown one errors', async () => {
    const a = await project('api')
    const b = await project('other')
    daemon(a, 'api', 18081)
    expect((await resolveProjectTarget({ project: a.projectId, cwd: work })).endpoint).toBe('http://localhost:18081')
    expect((await resolveProjectTarget({ project: 'api', cwd: work })).endpoint).toBe('http://localhost:18081')
    // A second project also named "api".
    const twinRoot = path.join(work, 'twin')
    await fs.mkdir(twinRoot)
    const { identity } = await ensureProjectIdentity(twinRoot, { name: 'api' })
    await addProject({ name: 'api-twin', path: twinRoot, languages: [], status: 'active' })
    await expect(resolveProjectTarget({ project: 'api', cwd: work })).rejects.toThrow(new RegExp(`names 2 projects[\\s\\S]*${identity.projectId}`))
    await expect(resolveProjectTarget({ project: 'nope', cwd: work })).rejects.toThrow(/no project "nope"/)
    expect(b.projectId).not.toBe(a.projectId)
  })

  it('a project whose daemon is not running is an error naming neat up, never loopback', async () => {
    const p = await project('quiet')
    await expect(resolveProjectTarget({ cwd: p.root })).rejects.toThrow(/daemon isn't running — start it with `neat up`/)
  })

  it('a daemon-down error still carries the §6 line naming the resolved project', async () => {
    const p = await project('quiet')
    const err = await resolveProjectTarget({ cwd: p.root }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(TargetResolutionError)
    expect((err as TargetResolutionError).line).toBe(
      `project=quiet (${p.projectId}) · binding=local · daemon=(not running)`,
    )
  })

  it('a hosted-no-login error carries the §6 line naming the hosted project', async () => {
    const p = await project('shop')
    await fs.writeFile(
      path.join(p.root, '.neat/binding.json'),
      JSON.stringify({ schemaVersion: 1, binding: 'hosted', org: 'org_acme' }),
    )
    const err = await resolveProjectTarget({ cwd: p.root }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(TargetResolutionError)
    expect((err as TargetResolutionError).line).toBe(
      `project=shop (${p.projectId}) · binding=hosted@org_acme · daemon=(your hosted login)`,
    )
  })

  it('a truly unresolved target (no project here) throws without a §6 line', async () => {
    const err = await resolveProjectTarget({ cwd: work }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(TargetResolutionError)
    expect((err as TargetResolutionError).line).toBeUndefined()
  })

  it('a legacy registration resolves with a notice and writes nothing', async () => {
    const root = path.join(work, 'legacy')
    await fs.mkdir(root)
    await addProject({ name: 'legacy', path: root, languages: [], status: 'active' })
    daemon({ root }, 'legacy', 18082)
    const t = await resolveProjectTarget({ cwd: root })
    expect(t).toMatchObject({ endpoint: 'http://localhost:18082', source: 'legacy' })
    expect(t.notices[0]).toMatch(/legacy has no \.neat\/project\.json yet — run `neat init`/)
    expect(t.line).toBe('project=legacy (no id yet) · binding=local · daemon=http://localhost:18082')
    await expect(fs.access(path.join(root, '.neat'))).rejects.toThrow()
  })

  it('a legacy project whose daemon is down gets the neat init notice with the error', async () => {
    const root = path.join(work, 'legacy-down')
    await fs.mkdir(root)
    await addProject({ name: 'legacy-down', path: root, languages: [], status: 'active' })
    const err = await resolveProjectTarget({ cwd: root }).catch((e) => e)
    expect(err).toBeInstanceOf(TargetResolutionError)
    expect(err.message).toMatch(/daemon isn't running — start it with `neat up`[\s\S]*\nlegacy-down has no \.neat\/project\.json yet — run `neat init`/)
  })

  it('outside any project it errors and names the running daemons, never picking one', async () => {
    const p = await project('only')
    daemon(p, 'only', 18083)
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-resolve-nowhere-'))
    try {
      const err = await resolveProjectTarget({ cwd: elsewhere }).catch((e) => e)
      expect(err).toBeInstanceOf(TargetResolutionError)
      expect(err.message).toMatch(/no NEAT project here[\s\S]*only → http:\/\/localhost:18083/)
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('an explicit pin is used as given and says so', async () => {
    process.env.NEAT_CORE_URL = 'http://ci:9000'
    const t = await resolveProjectTarget({ cwd: work })
    expect(t).toMatchObject({ endpoint: 'http://ci:9000', source: 'env' })
    expect(t.line).toMatch(/binding=pinned · daemon=http:\/\/ci:9000$/)
    await expect(resolveProjectTarget({ profile: 'missing', cwd: work })).rejects.toBeInstanceOf(UnknownProfileError)
  })

  it('an absent binding.json is local and says so', async () => {
    const p = await project('nobinding')
    await fs.rm(path.join(p.root, '.neat/binding.json'))
    daemon(p, 'nobinding', 18084)
    const t = await resolveProjectTarget({ cwd: p.root })
    expect(t.notices).toEqual(['no .neat/binding.json — treating nobinding as local'])
  })
})
