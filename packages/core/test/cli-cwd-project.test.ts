import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { addProject, findProjectByPath } from '../src/registry.js'
import {
  ProjectResolutionError,
  cwdProjectApplies,
  projectForCwd,
  resolveProjectForVerb,
} from '../src/cli.js'
import type { HttpClient } from '../src/cli-client.js'

// #1157 — a verb that names no project belongs to the project the person is standing
// in. Before this, it went to whichever daemon owned the loopback default and took that
// daemon's sole project as the answer, so from a second repo it read the first repo's
// graph without saying so.

let home: string
let prevHome: string | undefined
let root: string

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cwd-home-'))
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cwd-root-')))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(root, { recursive: true, force: true })
})

async function repo(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, 'services', 'api'), { recursive: true })
  await addProject({ name, path: dir })
  return dir
}

// A client that fails the test if the daemon is asked anything.
const silentClient = {
  get: async () => {
    throw new Error('the daemon should not have been asked')
  },
} as unknown as HttpClient

const noFlags = { project: null } as Parameters<typeof resolveProjectForVerb>[1]

describe('findProjectByPath', () => {
  it('finds the project registered at a directory', async () => {
    const a = await repo('alpha')
    await repo('beta')
    expect((await findProjectByPath(a))?.name).toBe('alpha')
  })

  it('finds the enclosing project from a subdirectory', async () => {
    const a = await repo('alpha')
    expect((await findProjectByPath(path.join(a, 'services', 'api')))?.name).toBe('alpha')
  })

  it('prefers the nearest registered ancestor', async () => {
    const outer = await repo('outer')
    const inner = path.join(outer, 'services', 'api')
    await addProject({ name: 'inner', path: inner })
    expect((await findProjectByPath(inner))?.name).toBe('inner')
    expect((await findProjectByPath(path.join(outer, 'services')))?.name).toBe('outer')
  })

  it('does not match a sibling that merely shares a name prefix', async () => {
    await repo('api')
    const sibling = path.join(root, 'api-gateway')
    await fs.mkdir(sibling, { recursive: true })
    expect(await findProjectByPath(sibling)).toBeUndefined()
  })

  it('returns nothing outside every registered project', async () => {
    await repo('alpha')
    expect(await findProjectByPath(os.tmpdir())).toBeUndefined()
  })
})

describe('projectForCwd', () => {
  it('names the project for a directory inside one', async () => {
    const a = await repo('alpha')
    expect(await projectForCwd(a)).toBe('alpha')
  })

  it('is undefined — never a throw — when the registry cannot be parsed', async () => {
    await fs.writeFile(path.join(home, 'projects.json'), '{ not json', 'utf8')
    expect(await projectForCwd(root)).toBeUndefined()
  })
})

describe('resolveProjectForVerb with a cwd project', () => {
  it('uses the cwd project without asking the daemon', async () => {
    expect(await resolveProjectForVerb(silentClient, noFlags, 'beta')).toBe('beta')
  })

  it('lets --project override it', async () => {
    const parsed = { project: 'alpha' } as Parameters<typeof resolveProjectForVerb>[1]
    expect(await resolveProjectForVerb(silentClient, parsed, 'beta')).toBe('alpha')
  })

  it('refuses, against a local daemon, when the directory is not a project', async () => {
    // Exit 2 and the command that fixes it — never the machine's other project.
    const err = await resolveProjectForVerb(silentClient, noFlags, undefined, true).catch((e) => e)
    expect(err).toBeInstanceOf(ProjectResolutionError)
    expect((err as ProjectResolutionError).exitCode).toBe(2)
    expect((err as Error).message).toBe(
      "This directory isn't a NEAT project yet — run `npx neat.is` here first, or pass --project <name>.",
    )
  })

  it('lets --project through from a directory that is not a project', async () => {
    const parsed = { project: 'alpha' } as Parameters<typeof resolveProjectForVerb>[1]
    expect(await resolveProjectForVerb(silentClient, parsed, undefined, true)).toBe('alpha')
  })

  it('still asks the daemon when the target is not local', async () => {
    const client = { get: async () => [{ name: 'only' }] } as unknown as HttpClient
    expect(await resolveProjectForVerb(client, noFlags, undefined, false)).toBe('only')
  })
})

describe('cwdProjectApplies', () => {
  it('holds for a local daemon — its own record, or loopback', () => {
    expect(cwdProjectApplies('daemon-record')).toBe(true)
    expect(cwdProjectApplies('default')).toBe(true)
  })

  it('does not reach into a daemon with its own project namespace', () => {
    // A hosted tenant, an env-pinned endpoint, or a named profile knows nothing of this
    // machine's registry; handing it a local project name would turn a working verb
    // into a 404.
    expect(cwdProjectApplies('active')).toBe(false)
    expect(cwdProjectApplies('profile')).toBe(false)
    expect(cwdProjectApplies('env')).toBe(false)
  })
})
