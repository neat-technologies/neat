import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addProject,
  registryLockPath,
  registryPath,
  ProjectNameCollisionError,
  RegistryError,
} from '../src/registry.js'

// #1241 — a run killed while holding the registry lock leaves the file behind,
// and every later run then waited five seconds and threw. One interrupted run
// blocked every project on the machine until someone deleted a file they had
// never heard of.
//
// #1240 — the messages carried their own `neat registry:` prefix on top of the
// `neat: ` the CLI adds, so they printed doubled.

const homes: string[] = []

async function sandbox(): Promise<string> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-lock-')))
  homes.push(home)
  process.env.NEAT_HOME = home
  return home
}

const projectDir = async (): Promise<string> => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-proj-')))
  homes.push(d)
  return d
}

afterEach(async () => {
  while (homes.length > 0) await fs.rm(homes.pop()!, { recursive: true, force: true }).catch(() => {})
})

// A PID that cannot be alive. 2^22 is above every platform's pid_max default,
// so `kill(pid, 0)` reports no such process rather than someone else's.
const DEAD_PID = 4_194_303

describe('a lock left behind by a dead process', () => {
  it('is reclaimed, not waited on', async () => {
    const home = await sandbox()
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(registryLockPath(), `${DEAD_PID}\n`, 'utf8')

    const started = Date.now()
    const entry = await addProject({ name: 'reclaimed', path: await projectDir(), languages: ['typescript'] })
    const elapsed = Date.now() - started

    expect(entry.name).toBe('reclaimed')
    // The old behaviour spun the full 5s timeout and then threw.
    expect(elapsed).toBeLessThan(2_000)
    expect(JSON.parse(await fs.readFile(registryPath(), 'utf8')).projects).toHaveLength(1)
  })

  it('leaves no lock file behind afterwards', async () => {
    const home = await sandbox()
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(registryLockPath(), `${DEAD_PID}\n`, 'utf8')
    await addProject({ name: 'p', path: await projectDir(), languages: ['typescript'] })
    await expect(fs.access(registryLockPath())).rejects.toThrow()
  })

  it('waits out the grace window before taking a lock that carries no PID', async () => {
    // An empty lock may belong to a holder that has created the file and not
    // yet stamped it. Only an old one is safe to take.
    const home = await sandbox()
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(registryLockPath(), '', 'utf8')
    // Age it past the grace window.
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(registryLockPath(), old, old)
    const entry = await addProject({ name: 'aged', path: await projectDir(), languages: ['typescript'] })
    expect(entry.name).toBe('aged')
  })

  it('reclaims a lock whose PID is unreadable garbage, once it has aged', async () => {
    const home = await sandbox()
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(registryLockPath(), 'not-a-pid\n', 'utf8')
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(registryLockPath(), old, old)
    const entry = await addProject({ name: 'garbage', path: await projectDir(), languages: ['typescript'] })
    expect(entry.name).toBe('garbage')
  })
})

describe('registry error messages', () => {
  it('carry no prefix of their own — the printer adds one (#1240)', async () => {
    await sandbox()
    const dir = await projectDir()
    await addProject({ name: 'dup', path: dir, languages: ['typescript'] })
    const other = await projectDir()
    const err = await addProject({ name: 'dup', path: other, languages: ['typescript'] }).catch((e) => e)
    expect(err).toBeInstanceOf(ProjectNameCollisionError)
    expect(err.message).toBe('a project named "dup" is already registered')
    // `neat: ${err.message}` is what the caller prints; it must not double up.
    expect(`neat: ${err.message}`).not.toContain('neat: neat')
  })

  it('keep their identity on the class, for callers that are not the CLI', async () => {
    await sandbox()
    const dir = await projectDir()
    await addProject({ name: 'x', path: dir, languages: ['typescript'] })
    const err = await addProject({ name: 'x', path: await projectDir(), languages: ['typescript'] }).catch(
      (e) => e,
    )
    // One catch covers the family; the name says where it came from.
    expect(err).toBeInstanceOf(RegistryError)
    expect(err.name).toBe('ProjectNameCollisionError')
  })
})
