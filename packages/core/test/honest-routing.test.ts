import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { addProject } from '../src/registry.js'
import { ensureProjectIdentity } from '../src/project-identity.js'
import { assertLocalBinding, HostedBindingError } from '../src/project-resolve.js'
import { runUpCommand } from '../src/up-cli.js'
import { runOrchestrator } from '../src/orchestrator.js'

// ADR-273 / WO-0.3 — a command that acts on this machine (`neat up`, `neat watch`,
// the bare `neat <path>`) on a project bound to hosted fails loudly with the org
// and the two ways forward, and starts, writes and prints nothing that reads as
// ready (project-identity.md §5). The Newdryve roadbump #11 was `neat up` printing
// "✓ Ready" while everything went to hosted.

const MESSAGE =
  'newdryve is hosted (runs in org_acme); it isn\'t yours to start here. Use `neat open` to connect to it, or `neat project set-local` to make it local on this machine.'

let home: string
let repo: string
let prevHome: string | undefined

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-honest-home-'))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-honest-repo-'))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'newdryve', version: '1.0.0', main: 'index.js' }))
  await fs.writeFile(path.join(repo, 'index.js'), 'module.exports = {}\n')
  await ensureProjectIdentity(repo, { name: 'newdryve' })
  await fs.writeFile(path.join(repo, '.neat/binding.json'), JSON.stringify({ schemaVersion: 1, binding: 'hosted', org: 'org_acme' }))
  await addProject({ name: 'newdryve', path: repo })
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(repo, { recursive: true, force: true })
})

describe('local-only commands on a hosted binding (ADR-273 §5)', () => {
  it('assertLocalBinding throws the contract message from anywhere inside the project', async () => {
    const sub = path.join(repo, 'src')
    await fs.mkdir(sub)
    expect(() => assertLocalBinding(sub)).toThrow(HostedBindingError)
    expect(() => assertLocalBinding(sub)).toThrow(MESSAGE)
  })

  it('a local binding, or no project, passes', async () => {
    await fs.writeFile(path.join(repo, '.neat/binding.json'), JSON.stringify({ schemaVersion: 1, binding: 'local' }))
    expect(() => assertLocalBinding(repo)).not.toThrow()
    expect(() => assertLocalBinding(os.tmpdir())).not.toThrow()
  })

  it('neat up exits 2 with the message and starts nothing, never a ready line (#11)', async () => {
    const out: string[] = []
    const err: string[] = []
    let ensured = 0
    const code = await runUpCommand([], {
      cwd: repo,
      env: {},
      resolveTarget: async () => ({ endpoint: 'this machine', local: true, via: 'test' }),
      ensureDaemon: async () => {
        ensured++
        return { status: 'spawned', ports: { rest: 1, otlp: 2, web: 3 }, brokenProjects: [] }
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    })
    expect(code).toBe(2)
    expect(ensured).toBe(0)
    expect(err).toEqual([`neat up: ${MESSAGE}`])
    expect(out.join('\n')).not.toMatch(/ready|started/i)
  })

  it('the bare run exits 2 before it extracts, registers or writes anything', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      errors.push(String(m))
    })
    const r = await runOrchestrator({
      scanPath: repo,
      project: 'newdryve',
      projectExplicit: false,
      noInstrument: true,
      noOpen: true,
      yes: true,
    })
    expect(r.exitCode).toBe(2)
    expect(errors).toEqual([`neat: ${MESSAGE}`])
    await expect(fs.access(path.join(repo, 'neat-out'))).rejects.toThrow()
    expect(r.steps.daemon).toBe('skipped')
  })
})
