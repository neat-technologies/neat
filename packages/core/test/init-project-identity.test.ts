import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROJECT_ID_RE } from '../src/project-identity.js'

// ADR-273 / WO-0.1 — `neat init` gives the project its identity: a committed
// .neat/project.json minted once, a local .neat/binding.json, and a .neat/.gitignore
// for the per-machine files (init.md step 3, project-identity.md §1–§2).

let home: string
let repo: string
let prevHome: string | undefined
let prevLog: typeof console.log
let prevErr: typeof console.error
let errors: string[]

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-init-id-home-'))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-init-id-repo-'))
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'orders', version: '1.0.0', main: 'index.js' }))
  await fs.writeFile(path.join(repo, 'index.js'), 'module.exports = {}\n')
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
  prevLog = console.log
  prevErr = console.error
  errors = []
  console.log = () => {}
  console.error = (...a: unknown[]) => {
    errors.push(a.join(' '))
  }
})
afterEach(async () => {
  console.log = prevLog
  console.error = prevErr
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(repo, { recursive: true, force: true })
})

async function init(over: { dryRun?: boolean; project?: string; projectExplicit?: boolean } = {}) {
  const { runInit } = await import('../src/cli.js')
  return runInit({
    scanPath: repo,
    outPath: path.join(repo, 'neat-out', 'graph.json'),
    project: over.project ?? 'orders',
    projectExplicit: over.projectExplicit ?? false,
    apply: false,
    dryRun: over.dryRun ?? false,
    noInstall: true,
    verbose: false,
  })
}

const readJson = async (rel: string) => JSON.parse(await fs.readFile(path.join(repo, rel), 'utf8'))

describe('neat init writes the project identity (ADR-273)', () => {
  it('a fresh repo gets .neat/project.json, a local binding and .neat/.gitignore', async () => {
    const r = await init()
    expect(r.exitCode).toBe(0)
    const id = await readJson('.neat/project.json')
    expect(id).toMatchObject({ schemaVersion: 1, name: 'orders' })
    expect(id.projectId).toMatch(PROJECT_ID_RE)
    expect(await readJson('.neat/binding.json')).toEqual({ schemaVersion: 1, binding: 'local' })
    expect(await fs.readFile(path.join(repo, '.neat/.gitignore'), 'utf8')).toContain('binding.json')
    expect(r.writtenFiles).toContain(path.join(repo, '.neat', 'project.json'))
  })

  it('re-running init keeps the projectId', async () => {
    await init()
    const first = (await readJson('.neat/project.json')).projectId
    expect((await init()).exitCode).toBe(0)
    expect((await readJson('.neat/project.json')).projectId).toBe(first)
  })

  it('an explicit --project renames, never re-mints', async () => {
    await init()
    const first = await readJson('.neat/project.json')
    await init({ project: 'orders-api', projectExplicit: true })
    expect(await readJson('.neat/project.json')).toEqual({ ...first, name: 'orders-api' })
  })

  it('a dry run writes no identity', async () => {
    expect((await init({ dryRun: true })).exitCode).toBe(0)
    await expect(fs.access(path.join(repo, '.neat'))).rejects.toThrow()
  })

  it('a malformed identity file stops init and is left as it was', async () => {
    await fs.mkdir(path.join(repo, '.neat'))
    await fs.writeFile(path.join(repo, '.neat/project.json'), '{"schemaVersion": 9}')
    expect((await init()).exitCode).toBe(1)
    expect(await fs.readFile(path.join(repo, '.neat/project.json'), 'utf8')).toBe('{"schemaVersion": 9}')
    expect(errors.join('\n')).toMatch(/schemaVersion 9/)
  })
})
