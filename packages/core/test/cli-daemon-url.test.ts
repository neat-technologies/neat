import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { daemonsDir, type DaemonRecord } from '../src/registry.js'
import { resolveDaemonUrl } from '../src/cli.js'

// Issue #579 — a query verb with --project <name> has to reach that project's
// own daemon. Under one-daemon-per-project the REST port lives in the discovery
// record at ~/.neat/daemons/<name>.json; resolveDaemonUrl reads it there instead
// of blindly returning the loopback default.

let home: string
let prevHome: string | undefined
let prevApi: string | undefined
let prevCore: string | undefined

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cli-url-home-'))
  prevHome = process.env.NEAT_HOME
  prevApi = process.env.NEAT_API_URL
  prevCore = process.env.NEAT_CORE_URL
  process.env.NEAT_HOME = home
  delete process.env.NEAT_API_URL
  delete process.env.NEAT_CORE_URL
})

afterEach(async () => {
  restore('NEAT_HOME', prevHome)
  restore('NEAT_API_URL', prevApi)
  restore('NEAT_CORE_URL', prevCore)
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
