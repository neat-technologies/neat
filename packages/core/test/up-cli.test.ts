import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { addProject } from '../src/registry.js'
import { runUpCommand, type UpTarget } from '../src/up-cli.js'
import type { EnsureDaemonOptions, EnsureDaemonOutcome } from '../src/orchestrator.js'

// `neat up` (#1250) — the one command that starts a project's daemon without
// extracting anything. Reads stay reads; this is what their daemon-down message
// names.

let home: string
let prevHome: string | undefined
let root: string
let out: string[]
let err: string[]
let ensured: EnsureDaemonOptions[]

const PORTS = { rest: 8081, otlp: 4319, web: 6329 }
const local: UpTarget = { endpoint: 'http://localhost:8081', local: true, via: 'your environment' }

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-up-home-'))
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-up-root-')))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
  out = []
  err = []
  ensured = []
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(root, { recursive: true, force: true })
})

async function repo(name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await addProject({ name, path: dir })
  return dir
}

function run(
  argv: string[],
  cwd: string,
  outcome: EnsureDaemonOutcome,
  target: UpTarget = local,
): Promise<number> {
  return runUpCommand(argv, {
    cwd,
    env: {},
    resolveTarget: async () => target,
    ensureDaemon: async (opts) => {
      ensured.push(opts)
      return outcome
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  })
}

describe('neat up', () => {
  it('starts the daemon for the project the directory belongs to', async () => {
    const dir = await repo('alpha')
    const code = await run([], path.join(dir, 'src'), {
      status: 'spawned',
      ports: PORTS,
      brokenProjects: [],
    })
    expect(code).toBe(0)
    expect(ensured).toEqual([{ project: 'alpha', projectPath: dir }])
    expect(out[0]).toBe('neat up: started alpha — http://localhost:8081')
    expect(out[1]).toContain(':4319')
    expect(out[1]).toContain('daemon.log')
  })

  it('says so and does nothing else when it is already running', async () => {
    const dir = await repo('alpha')
    const code = await run([], dir, { status: 'already-running', ports: PORTS })
    expect(code).toBe(0)
    expect(out).toEqual(['neat up: alpha is already running — http://localhost:8081'])
    expect(err).toEqual([])
  })

  it('takes --project from anywhere', async () => {
    const dir = await repo('alpha')
    const code = await run(['--project', 'alpha'], os.tmpdir(), {
      status: 'already-running',
      ports: PORTS,
    })
    expect(code).toBe(0)
    expect(ensured[0]!.projectPath).toBe(dir)
  })

  it('exits 2 outside a project, and starts nothing', async () => {
    await repo('alpha')
    const code = await run([], os.tmpdir(), { status: 'already-running', ports: PORTS })
    expect(code).toBe(2)
    expect(ensured).toEqual([])
    expect(err[0]).toContain("isn't a NEAT project yet")
    expect(err[0]).toContain('npx neat.is')
  })

  it('exits 2 for a project name nothing is registered under', async () => {
    const code = await run(['--project', 'ghost'], root, { status: 'already-running', ports: PORTS })
    expect(code).toBe(2)
    expect(ensured).toEqual([])
    expect(err[0]).toContain('"ghost"')
  })

  it("will not start a daemon that isn't this machine's", async () => {
    const dir = await repo('alpha')
    const code = await run([], dir, { status: 'already-running', ports: PORTS }, {
      endpoint: 'https://acme.neat.is',
      local: false,
      via: 'your active profile',
    })
    expect(code).toBe(2)
    expect(ensured).toEqual([])
    expect(err.join('\n')).toContain('https://acme.neat.is')
    expect(err.join('\n')).toContain("isn't yours to start")
  })

  it('exits 1 and shows the cause when the daemon never comes up', async () => {
    const dir = await repo('alpha')
    await fs.mkdir(path.join(dir, 'neat-out'), { recursive: true })
    await fs.writeFile(path.join(dir, 'neat-out', 'daemon.log'), 'neatd: EACCES on /data\n', 'utf8')
    const code = await run([], dir, {
      status: 'timed-out',
      ports: PORTS,
      stillBootstrapping: [],
      brokenProjects: [],
    })
    expect(code).toBe(1)
    expect(err[0]).toMatch(/did not become ready/)
    expect(err.join('\n')).toContain('EACCES on /data')
  })

  it('exits 3 when no port set is free', async () => {
    const dir = await repo('alpha')
    expect(await run([], dir, { status: 'no-ports' })).toBe(3)
  })

  it('--json prints one object and nothing else', async () => {
    const dir = await repo('alpha')
    const code = await run(['--json'], dir, { status: 'spawned', ports: PORTS, brokenProjects: [] })
    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0]!)).toMatchObject({
      project: 'alpha',
      path: dir,
      status: 'spawned',
      endpoint: 'http://localhost:8081',
      ports: PORTS,
    })
  })

  it('rejects an argument it does not know', async () => {
    const dir = await repo('alpha')
    expect(await run(['./somewhere'], dir, { status: 'no-ports' })).toBe(2)
    expect(ensured).toEqual([])
  })
})

describe('the query allowlist', () => {
  it('does not grow — `up` is not a query verb', async () => {
    const { QUERY_VERBS } = await import('../src/cli.js')
    expect(QUERY_VERBS.has('up')).toBe(false)
  })
})
