import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runProjectCommand } from '../src/project-cli.js'
import { pickClonedProject } from '../src/project-clone.js'
import { mintProjectId, readBinding, readProjectIdentity } from '../src/project-identity.js'
import { resolveProject } from '../src/project-resolve.js'

// #1521 / WO-1.2 — `neat project clone` gives a local checkout a hosted
// project's identity. The control plane is a stub that answers `GET /me` in the
// shape neat-infra#215 adds (projects[].neatProjectId); nothing reaches a real CP.

const HOSTED = mintProjectId()
const OTHER = mintProjectId()
const CP = 'https://cp.test'

function stubCp(projects: unknown[], opts: { status?: number; seen?: string[] } = {}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    opts.seen?.push(`${String(url)} ${(init?.headers as Record<string, string>)?.authorization ?? ''}`)
    if (String(url) !== `${CP}/me`) return { ok: false, status: 404, json: async () => ({}) } as Response
    const status = opts.status ?? 200
    return { ok: status < 300, status, json: async () => ({ org: { id: 'org_1' }, projects }) } as Response
  }) as unknown as typeof fetch
}

const PROJECTS = [
  { id: 'cp_1', name: 'checkout-api', displayName: 'Checkout API', neatProjectId: HOSTED, status: 'running' },
  { id: 'cp_2', name: 'console-made', status: 'running' },
  { id: 'cp_3', name: 'twin', neatProjectId: OTHER, status: 'running' },
  { id: 'cp_4', name: 'twin', neatProjectId: mintProjectId(), status: 'running' },
]

let dir: string
let lines: string[]
let errors: string[]
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-clone-')))
  lines = []
  errors = []
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function clone(args: string[], fetchImpl: typeof fetch = stubCp(PROJECTS), env: NodeJS.ProcessEnv = { NEAT_API_KEY: 'neat_pat_x', NEAT_CP_URL: CP }) {
  return runProjectCommand(['clone', ...args], {
    cwd: dir,
    env,
    fetchImpl,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
  })
}

describe('neat project clone', () => {
  it('writes the hosted id and a local binding, and the checkout then resolves to it as local', async () => {
    const seen: string[] = []
    expect(await clone([HOSTED], stubCp(PROJECTS, { seen }))).toBe(0)
    expect(seen).toEqual([`${CP}/me Bearer neat_pat_x`])
    expect(await readProjectIdentity(dir)).toEqual({ schemaVersion: 1, projectId: HOSTED, name: 'Checkout API' })
    expect(await readBinding(dir)).toMatchObject({ binding: 'local', absent: false })
    expect(await fs.readFile(path.join(dir, '.neat', '.gitignore'), 'utf8')).toContain('binding.json')
    const resolved = await resolveProject({ cwd: dir })
    expect(resolved).toMatchObject({ projectId: HOSTED, binding: 'local' })
    expect(lines.at(-1)).toBe(`project=Checkout API (${HOSTED}) · binding=local · daemon=(not running)`)
  })

  it('finds a project by name, into a path argument', async () => {
    await fs.mkdir(path.join(dir, 'repo'))
    expect(await clone(['checkout-api', 'repo'])).toBe(0)
    expect((await readProjectIdentity(path.join(dir, 'repo')))?.projectId).toBe(HOSTED)
  })

  it('refuses a directory that is already a different project, and changes nothing', async () => {
    await fs.mkdir(path.join(dir, '.neat'))
    await fs.writeFile(path.join(dir, '.neat', 'project.json'), JSON.stringify({ schemaVersion: 1, projectId: OTHER, name: 'mine' }))
    expect(await clone([HOSTED])).toBe(1)
    expect(errors.join('\n')).toContain('refusing to replace it')
    expect((await readProjectIdentity(dir))?.projectId).toBe(OTHER)
    expect((await readBinding(dir)).absent).toBe(true)
  })

  it('cloning the same id again is fine', async () => {
    expect(await clone([HOSTED])).toBe(0)
    expect(await clone([HOSTED])).toBe(0)
    expect((await readProjectIdentity(dir))?.projectId).toBe(HOSTED)
  })

  it('says why a console-made project with no NEAT id cannot be cloned', async () => {
    expect(await clone(['console-made'])).toBe(1)
    expect(errors.join('\n')).toContain('has no NEAT project id yet')
    expect(await readProjectIdentity(dir)).toBeUndefined()
  })

  it('names the ids when a name is shared, and an unknown name lists what exists', () => {
    const twin = pickClonedProject(PROJECTS, 'twin')
    expect('error' in twin && twin.error).toContain('several hosted projects are named "twin"')
    expect('error' in twin && twin.error).toContain(OTHER)
    const none = pickClonedProject(PROJECTS, 'nope')
    expect('error' in none && none.error).toContain('yours: Checkout API, console-made, twin, twin')
  })

  it('fails honestly without a key, on a 401, and on an unreachable CP', async () => {
    expect(await clone([HOSTED], stubCp(PROJECTS), { NEAT_CP_URL: CP })).toBe(2)
    expect(errors.at(-1)).toContain('not logged in')
    expect(await clone([HOSTED], stubCp(PROJECTS, { status: 401 }))).toBe(1)
    expect(errors.at(-1)).toContain('not authorized')
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await clone([HOSTED], down)).toBe(1)
    expect(errors.at(-1)).toContain(`can't reach the control plane at ${CP}`)
    expect(await readProjectIdentity(dir)).toBeUndefined()
  })

  it('usage on a missing argument, and a path that is not a directory', async () => {
    expect(await clone([])).toBe(2)
    expect(errors.join('\n')).toContain('usage: neat project clone')
    expect(await clone([HOSTED, 'no-such-dir'])).toBe(2)
    expect(errors.at(-1)).toContain('is not a directory')
  })
})
