import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { daemonsDir, type DaemonRecord } from '../src/registry.js'

// #366 / ADR-096 — the machine-wide CLI verbs (`list` / `ps` / `pause` /
// `resume` / `uninstall`) read the lock-free `~/.neat/daemons/` discovery
// directory. These drive `main()` with a stubbed argv against an isolated
// NEAT_HOME; the real ~/.neat and its live daemon are never touched. Every
// discovery file uses a guaranteed-dead pid so no real process is signalled.

const DEAD_PID = 2 ** 30

let home: string
let prevHome: string | undefined
const origArgv = process.argv
let exitSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cli-verbs-home-'))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__:${code ?? 0}`)
  }) as never)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  exitSpy.mockRestore()
  logSpy.mockRestore()
  errSpy.mockRestore()
  process.argv = origArgv
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
})

async function writeDaemonFile(over: Partial<DaemonRecord> = {}): Promise<void> {
  const record: DaemonRecord = {
    project: 'alpha',
    projectPath: '/tmp/alpha',
    pid: DEAD_PID,
    status: 'running',
    ports: { rest: 8080, otlp: 4318, web: 6328 },
    startedAt: '2026-06-13T00:00:00.000Z',
    neatVersion: '0.4.17',
    ...over,
  }
  const dir = daemonsDir()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${record.project}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8')
}

function logged(): string {
  return logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
}

async function runMain(args: string[]): Promise<void> {
  // argv[1] is neutral so the module's auto-run guard doesn't fire on import.
  process.argv = ['node', '/tmp/test-runner', ...args]
  const { main } = await import('../src/cli.js')
  await main()
}

describe('neat list / ps (discovery-backed)', () => {
  it('reports nothing when no daemons run and nothing is registered', async () => {
    await runMain(['list'])
    expect(logged()).toContain('no daemons running and no projects registered')
  })

  it('lists a discovered daemon (dead pid → stopped) with its ports', async () => {
    await writeDaemonFile({ project: 'alpha', pid: DEAD_PID })
    await runMain(['list'])
    const out = logged()
    expect(out).toContain('alpha')
    expect(out).toContain('stopped')
    expect(out).toContain('rest=8080')
    expect(out).toContain('otlp=4318')
    expect(out).toContain('web=6328')
  })

  it('ps is an alias of list', async () => {
    await writeDaemonFile({ project: 'beta', pid: DEAD_PID })
    await runMain(['ps'])
    expect(logged()).toContain('beta')
  })
})

describe('neat pause (per-daemon)', () => {
  it('reports the daemon was not running when its pid is dead', async () => {
    await writeDaemonFile({ project: 'alpha', pid: DEAD_PID })
    await runMain(['pause', 'alpha'])
    expect(logged()).toContain('daemon was not running')
  })
})

describe('neat uninstall (per-daemon)', () => {
  it('clears the discovery file and reports the project unregistered', async () => {
    await writeDaemonFile({ project: 'alpha', projectPath: '/tmp/alpha', pid: DEAD_PID })
    await runMain(['uninstall', 'alpha'])
    expect(logged()).toContain('unregistered: alpha')
    // The discovery file is gone.
    await expect(fs.access(path.join(daemonsDir(), 'alpha.json'))).rejects.toThrow()
  })

  it('errors when no daemon record and no registry entry exist', async () => {
    await expect(runMain(['uninstall', 'ghost'])).rejects.toThrow('__exit__:1')
  })
})

describe('neat resume (per-daemon)', () => {
  it('points the operator at re-running the orchestrator for a stopped daemon', async () => {
    await writeDaemonFile({ project: 'alpha', projectPath: '/tmp/alpha', pid: DEAD_PID })
    await runMain(['resume', 'alpha'])
    expect(logged()).toMatch(/start its daemon again/)
  })
})
