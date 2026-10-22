import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ensureProjectIdentity, writeProjectIdentity, mintProjectId } from '../src/project-identity.js'
import { addProject } from '../src/registry.js'
import { runProjectCommand } from '../src/project-cli.js'

// ADR-273 / WO-0.7 — `neat project set-local / set-hosted` flips this machine's
// binding to a project (.neat/binding.json) and moves nothing else.

let home: string
let repo: string
let prevHome: string | undefined
let out: string[]
let err: string[]

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-project-cli-home-'))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-project-cli-repo-'))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
  out = []
  err = []
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(repo, { recursive: true, force: true })
})

const run = (argv: string[]) => runProjectCommand(argv, { cwd: repo, out: (l) => out.push(l), err: (l) => err.push(l) })
const binding = async () => JSON.parse(await fs.readFile(path.join(repo, '.neat/binding.json'), 'utf8'))

describe('neat project (ADR-273, WO-0.7)', () => {
  it('set-hosted --org binds the project to hosted, then set-local back', async () => {
    const { identity } = await ensureProjectIdentity(repo, { name: 'newdryve' })
    expect(await run(['set-hosted', '--org', 'org_acme'])).toBe(0)
    expect(await binding()).toEqual({ schemaVersion: 1, binding: 'hosted', org: 'org_acme' })
    expect(out[0]).toBe('neat project: newdryve is now hosted@org_acme on this machine')
    expect(out.at(-1)).toBe(`project=newdryve (${identity.projectId}) · binding=hosted@org_acme · daemon=(your hosted login)`)
    out = []
    expect(await run(['set-local'])).toBe(0)
    expect(await binding()).toEqual({ schemaVersion: 1, binding: 'local' })
    expect(out).toContain('neat project: start its daemon here with `neat up`')
    out = []
    expect(await run(['set-local'])).toBe(0)
    expect(out[0]).toBe('neat project: newdryve is already local')
  })

  it('set-hosted without --org is refused and changes nothing', async () => {
    await ensureProjectIdentity(repo, { name: 'newdryve' })
    expect(await run(['set-hosted'])).toBe(2)
    expect(err[0]).toMatch(/--org <org> is required/)
    expect(await binding()).toEqual({ schemaVersion: 1, binding: 'local' })
  })

  it('a legacy project is told to run neat init first', async () => {
    await addProject({ name: 'legacy', path: repo })
    expect(await run(['set-local'])).toBe(2)
    expect(err[0]).toMatch(/legacy has no \.neat\/project\.json yet — run `neat init`/)
  })

  it('outside any project, and with an unknown subcommand, it errors', async () => {
    expect(await run(['set-local'])).toBe(2)
    expect(err[0]).toMatch(/no NEAT project here/)
    err = []
    expect(await run(['teleport'])).toBe(2)
    expect(err[0]).toBe('neat project: unknown subcommand `teleport`')
  })

  it('writeProjectIdentity keeps an existing id, rejects a malformed one, and never replaces a different one', async () => {
    const id = mintProjectId()
    expect(await writeProjectIdentity(repo, { projectId: id, name: 'cloned' })).toEqual({ schemaVersion: 1, projectId: id, name: 'cloned' })
    expect(JSON.parse(await fs.readFile(path.join(repo, '.neat/project.json'), 'utf8')).projectId).toBe(id)
    await expect(writeProjectIdentity(repo, { projectId: 'prj_abc', name: 'x' })).rejects.toThrow(/not a project id/)
    expect(await writeProjectIdentity(repo, { projectId: id, name: 'renamed' })).toMatchObject({ projectId: id, name: 'cloned' })
    await expect(writeProjectIdentity(repo, { projectId: mintProjectId(), name: 'other' })).rejects.toThrow(/already project cloned/)
  })
})
