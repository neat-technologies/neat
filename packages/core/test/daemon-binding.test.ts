import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveDaemonBindingLine } from '../src/daemon-binding.js'

// A project root with a committed .neat/project.json (+ optional binding.json),
// as `neat init` would leave it. Returned paths are cleaned up afterEach.
const roots: string[] = []
async function projectRoot(
  project: { projectId: string; name: string },
  binding?: { binding: 'local' | 'hosted'; org?: string },
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'neat-binding-'))
  roots.push(root)
  await mkdir(path.join(root, '.neat'), { recursive: true })
  await writeFile(
    path.join(root, '.neat', 'project.json'),
    JSON.stringify({ schemaVersion: 1, ...project }),
  )
  if (binding) {
    await writeFile(
      path.join(root, '.neat', 'binding.json'),
      JSON.stringify({ schemaVersion: 1, ...binding }),
    )
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('resolveDaemonBindingLine (project-identity.md §6)', () => {
  it('reads a local per-project daemon identity from the committed .neat/ files', async () => {
    const root = await projectRoot(
      { projectId: 'prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A', name: 'newdryve' },
      { binding: 'local' },
    )
    const line = await resolveDaemonBindingLine({
      singleProject: 'newdryve',
      singleProjectPath: root,
      daemonAddr: 'pid:4242:8080',
      env: {},
    })
    expect(line).toBe(
      'project=newdryve (prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A) · binding=local · daemon=pid:4242:8080',
    )
  })

  it('renders hosted@org from the committed binding.json', async () => {
    const root = await projectRoot(
      { projectId: 'prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A', name: 'newdryve' },
      { binding: 'hosted', org: 'org_01JC' },
    )
    const line = await resolveDaemonBindingLine({
      singleProject: 'newdryve',
      singleProjectPath: root,
      daemonAddr: 'pid:4242:8080',
      env: {},
    })
    expect(line).toContain('binding=hosted@org_01JC')
  })

  it('identifies a hosted tenant daemon from env (neat-infra#215 §11)', async () => {
    const line = await resolveDaemonBindingLine({
      daemonAddr: 'pid:1:9000',
      env: { NEAT_ORG: 'org_01JC', NEAT_PROJECT_NAME: 'acme', NEAT_PROJECT_ID: 'prj_01JDHOSTED0000000000000000' },
    })
    expect(line).toBe(
      'project=acme (prj_01JDHOSTED0000000000000000) · binding=hosted@org_01JC · daemon=pid:1:9000',
    )
  })

  it('renders (no id yet) for a console project — NEAT_ORG set, NEAT_PROJECT_ID absent', async () => {
    const line = await resolveDaemonBindingLine({
      daemonAddr: 'pid:1:9000',
      env: { NEAT_ORG: 'org_01JC', NEAT_PROJECT_NAME: 'acme' },
    })
    expect(line).toBe('project=acme (no id yet) · binding=hosted@org_01JC · daemon=pid:1:9000')
  })

  it('returns undefined for a legacy multi-project daemon (no singleProject, no env)', async () => {
    const line = await resolveDaemonBindingLine({ daemonAddr: 'pid:1:9000', env: {} })
    expect(line).toBeUndefined()
  })
})
