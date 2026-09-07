import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { daemonsDir, type DaemonRecord } from '../src/registry.js'
import { resolveDaemonUrl, resolveClientTarget, UnknownProfileError } from '../src/cli.js'
import { upsertProfile } from '../src/profiles.js'

// Issue #579 — a query verb with --project <name> has to reach that project's
// own daemon. Under one-daemon-per-project the REST port lives in the discovery
// record at ~/.neat/daemons/<name>.json; resolveDaemonUrl reads it there instead
// of blindly returning the loopback default.

let home: string
let prevHome: string | undefined
let prevApi: string | undefined
let prevCore: string | undefined
let prevProfile: string | undefined

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cli-url-home-'))
  prevHome = process.env.NEAT_HOME
  prevApi = process.env.NEAT_API_URL
  prevCore = process.env.NEAT_CORE_URL
  prevProfile = process.env.NEAT_PROFILE
  process.env.NEAT_HOME = home
  delete process.env.NEAT_API_URL
  delete process.env.NEAT_CORE_URL
  delete process.env.NEAT_PROFILE
})

afterEach(async () => {
  restore('NEAT_HOME', prevHome)
  restore('NEAT_API_URL', prevApi)
  restore('NEAT_CORE_URL', prevCore)
  restore('NEAT_PROFILE', prevProfile)
  await fs.rm(home, { recursive: true, force: true })
})

function restore(key: string, val: string | undefined): void {
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
}

async function writeDaemonRecord(over: Partial<DaemonRecord> = {}): Promise<void> {
  const record: DaemonRecord = {
    project: 'harvest',
    projectPath: '/tmp/harvest',
    pid: 4242,
    status: 'running',
    ports: { rest: 8123, otlp: 4319, web: 6329 },
    startedAt: '2026-06-27T00:00:00.000Z',
    neatVersion: '0.4.19',
    ...over,
  }
  const dir = daemonsDir()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${record.project}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8')
}

describe('resolveDaemonUrl', () => {
  it("resolves the requested project's daemon port from its discovery record", async () => {
    await writeDaemonRecord()
    expect(await resolveDaemonUrl('harvest')).toBe('http://localhost:8123')
  })

  it('falls back to loopback when the project has no discovery record', async () => {
    expect(await resolveDaemonUrl('harvest')).toBe('http://localhost:8080')
  })

  it('falls back to loopback for a bare verb with no project', async () => {
    await writeDaemonRecord()
    expect(await resolveDaemonUrl(undefined)).toBe('http://localhost:8080')
  })

  it('lets an explicit NEAT_API_URL pin win over discovery', async () => {
    await writeDaemonRecord()
    process.env.NEAT_API_URL = 'http://hosted.example:9000'
    expect(await resolveDaemonUrl('harvest')).toBe('http://hosted.example:9000')
  })

  it('honors NEAT_CORE_URL as the pin alias', async () => {
    await writeDaemonRecord()
    process.env.NEAT_CORE_URL = 'http://core.example:9100'
    expect(await resolveDaemonUrl('harvest')).toBe('http://core.example:9100')
  })
})

describe('resolveClientTarget — profile precedence (client-profiles.md §3)', () => {
  it('an active profile beats a local daemon record, and carries its token', async () => {
    await writeDaemonRecord()
    await upsertProfile({ name: 'hosted', endpoint: 'https://neat-acme.run.app', authToken: 'dtok' }, { home })
    expect(await resolveClientTarget({ project: 'harvest' })).toEqual({
      endpoint: 'https://neat-acme.run.app',
      authToken: 'dtok',
      source: 'active',
    })
  })

  it('an env pin overrides a stored active profile', async () => {
    await upsertProfile({ name: 'hosted', endpoint: 'https://neat-acme.run.app', authToken: 'dtok' }, { home })
    process.env.NEAT_API_URL = 'http://pin.example:9000'
    const target = await resolveClientTarget({})
    expect(target.endpoint).toBe('http://pin.example:9000')
    expect(target.source).toBe('env')
  })

  it('--profile names a profile explicitly, above an env pin', async () => {
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 'a' }, { home })
    await upsertProfile({ name: 'staging', endpoint: 'https://s.run.app', authToken: 'b' }, { home })
    process.env.NEAT_API_URL = 'http://pin.example:9000'
    expect(await resolveClientTarget({ profile: 'staging' })).toEqual({
      endpoint: 'https://s.run.app',
      authToken: 'b',
      source: 'profile',
    })
  })

  it('NEAT_PROFILE env selects a profile when no flag is passed', async () => {
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 'a' }, { home })
    process.env.NEAT_PROFILE = 'hosted'
    expect((await resolveClientTarget({})).source).toBe('profile')
  })

  it('an explicitly named profile that does not exist is a loud error, not a fall-through', async () => {
    await expect(resolveClientTarget({ profile: 'ghost' })).rejects.toBeInstanceOf(UnknownProfileError)
  })

  it('a machine that never logged in falls straight through to local discovery', async () => {
    await writeDaemonRecord()
    expect(await resolveClientTarget({ project: 'harvest' })).toEqual({
      endpoint: 'http://localhost:8123',
      source: 'daemon-record',
    })
  })
})
