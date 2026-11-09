import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  PROJECT_ID_RE,
  ProjectIdentityError,
  ensureProjectIdentity,
  findProjectRoot,
  mintProjectId,
  readBinding,
  readProjectIdentity,
  bindingLine,
} from '../src/project-identity.js'

// ADR-273 / WO-0.1 — a project's identity is a committed .neat/project.json
// (prj_<ULID> + name), and how this machine reaches it a gitignored
// .neat/binding.json. docs/contracts/project-identity.md §1–§2.

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-identity-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const read = async (rel: string): Promise<string> => fs.readFile(path.join(root, rel), 'utf8')

describe('projectId', () => {
  it('is prj_ + a 26-character upper-case Crockford ULID, time first', () => {
    const id = mintProjectId(Date.UTC(2026, 9, 22), Buffer.alloc(10, 0xff))
    expect(id).toMatch(PROJECT_ID_RE)
    expect(id).toMatch(/^prj_[0-7]/) // a 48-bit time never sets the top bits; the CP's validator relies on it
    expect(id.slice(14)).toBe('ZZZZZZZZZZZZZZZZ')
    expect(mintProjectId(1)).not.toBe(mintProjectId(1))
    expect(mintProjectId(Date.UTC(2026, 9, 22)) < mintProjectId(Date.UTC(2026, 9, 23))).toBe(true)
  })
})

describe('ensureProjectIdentity', () => {
  it('a fresh repo gets an id, a local binding and a .neat/.gitignore', async () => {
    const r = await ensureProjectIdentity(root, { name: 'newdryve' })
    expect(r.createdIdentity).toBe(true)
    expect(r.createdBinding).toBe(true)
    expect(JSON.parse(await read('.neat/project.json'))).toEqual({ schemaVersion: 1, projectId: r.identity.projectId, name: 'newdryve' })
    expect(JSON.parse(await read('.neat/binding.json'))).toEqual({ schemaVersion: 1, binding: 'local' })
    expect((await read('.neat/.gitignore')).split('\n')).toEqual(expect.arrayContaining(['binding.json', 'connectors.json']))
  })

  it('re-running keeps the id and the binding and writes nothing', async () => {
    const first = await ensureProjectIdentity(root, { name: 'newdryve' })
    await fs.writeFile(path.join(root, '.neat/binding.json'), JSON.stringify({ schemaVersion: 1, binding: 'hosted', org: 'org_1' }))
    const again = await ensureProjectIdentity(root, { name: 'something-else' })
    expect(again.identity.projectId).toBe(first.identity.projectId)
    expect(again.identity.name).toBe('newdryve')
    expect(again.binding).toEqual({ schemaVersion: 1, binding: 'hosted', org: 'org_1' })
    expect(again.writtenFiles).toEqual([])
  })

  it('an explicit rename changes the name, never the id', async () => {
    const first = await ensureProjectIdentity(root, { name: 'newdryve' })
    const renamed = await ensureProjectIdentity(root, { name: 'newdryve-api', rename: true })
    expect(renamed.renamed).toBe(true)
    expect(renamed.identity).toEqual({ ...first.identity, name: 'newdryve-api' })
  })

  it('an existing .neat/.gitignore keeps its lines and gains only what is missing', async () => {
    await fs.mkdir(path.join(root, '.neat'))
    await fs.writeFile(path.join(root, '.neat/.gitignore'), 'scratch/\nbinding.json\n')
    await ensureProjectIdentity(root, { name: 'x' })
    expect(await read('.neat/.gitignore')).toBe('scratch/\nbinding.json\nconnectors.json\n')
  })
})

describe('reading', () => {
  it('no files: no identity, and the binding is local and says it was absent', async () => {
    expect(await readProjectIdentity(root)).toBeUndefined()
    expect(await readBinding(root)).toEqual({ schemaVersion: 1, binding: 'local', absent: true })
  })

  it('an unknown schemaVersion, a bad id, or a hosted binding with no org is an error', async () => {
    await fs.mkdir(path.join(root, '.neat'))
    await fs.writeFile(path.join(root, '.neat/project.json'), JSON.stringify({ schemaVersion: 2, projectId: mintProjectId(), name: 'x' }))
    await expect(readProjectIdentity(root)).rejects.toThrow(/schemaVersion 2/)
    await fs.writeFile(path.join(root, '.neat/project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'default', name: 'x' }))
    await expect(readProjectIdentity(root)).rejects.toBeInstanceOf(ProjectIdentityError)
    await fs.writeFile(path.join(root, '.neat/binding.json'), JSON.stringify({ schemaVersion: 1, binding: 'hosted' }))
    await expect(readBinding(root)).rejects.toThrow(/needs an org/)
  })

  it('findProjectRoot walks up to the nearest .neat/project.json', async () => {
    await ensureProjectIdentity(root, { name: 'outer' })
    const deep = path.join(root, 'services', 'api', 'src')
    await fs.mkdir(deep, { recursive: true })
    expect(await findProjectRoot(deep)).toBe(root)
    const inner = path.join(root, 'services', 'api')
    await ensureProjectIdentity(inner, { name: 'inner' })
    expect(await findProjectRoot(deep)).toBe(inner)
    expect(await findProjectRoot(os.tmpdir())).toBeUndefined()
  })
})

describe('bindingLine', () => {
  it('renders the §6 line for each binding', () => {
    expect(bindingLine({ name: 'newdryve', projectId: 'prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A', binding: 'local', daemon: 'http://localhost:18080' }))
      .toBe('project=newdryve (prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A) · binding=local · daemon=http://localhost:18080')
    expect(bindingLine({ name: 'shop', projectId: 'prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A', binding: 'hosted', org: 'org_9', daemon: 'https://t.neat.is' }))
      .toBe('project=shop (prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A) · binding=hosted@org_9 · daemon=https://t.neat.is')
    expect(bindingLine({ name: 'old', binding: 'pinned', daemon: 'http://ci:8080' })).toBe('project=old (no id yet) · binding=pinned · daemon=http://ci:8080')
  })
})
