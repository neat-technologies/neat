import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { FastifyInstance } from 'fastify'
import { buildApi } from '../src/api.js'
import { Projects, pathsForProject } from '../src/projects.js'
import { getGraph, resetGraph } from '../src/graph.js'
import { addProject, daemonsDir } from '../src/registry.js'

// #884 — the project registry (`~/.neat/projects.json`) is shared across every
// daemon on the machine, so a single core's GET /projects lists projects other
// daemons own and its per-project endpoints 404 on them. Pointed at the wrong
// core, an agent otherwise gets confident answers about a different codebase.
// The fixes: mark which projects THIS daemon hosts (`hostedHere`), name the
// owning daemon on a lookup served elsewhere, and make the data-route 404 point
// back at /projects instead of reading as "no such project". Each runs against
// an isolated NEAT_HOME tmpdir — the real ~/.neat is never touched.

let home: string
let prevHome: string | undefined
let app: FastifyInstance | undefined

beforeEach(async () => {
  resetGraph()
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-884-home-'))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
})

afterEach(async () => {
  await app?.close()
  app = undefined
  resetGraph()
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
})

// This daemon hosts only `hosted`; `elsewhere` is registered but served by
// another daemon on the machine.
async function buildMultiProjectApi(): Promise<FastifyInstance> {
  await addProject({ name: 'hosted', path: home })
  await addProject({ name: 'elsewhere', path: path.join(home, 'elsewhere-repo') })
  const registry = new Projects()
  registry.set('hosted', { graph: getGraph('hosted'), paths: pathsForProject('hosted', home) })
  return buildApi({ projects: registry })
}

describe('#884 — /projects marks which projects this daemon hosts', () => {
  it('annotates each registry entry with hostedHere', async () => {
    app = await buildMultiProjectApi()
    const res = await app.inject({ method: 'GET', url: '/projects' })
    expect(res.statusCode).toBe(200)
    const byName = Object.fromEntries(
      (res.json() as { name: string; hostedHere: boolean }[]).map((e) => [e.name, e]),
    )
    expect(byName.hosted.hostedHere).toBe(true)
    expect(byName.elsewhere.hostedHere).toBe(false)
  })

  it('names the owning daemon when a looked-up project is served elsewhere', async () => {
    app = await buildMultiProjectApi()
    // Drop a discovery record for `elsewhere`, as its owning daemon would.
    await fs.mkdir(daemonsDir(), { recursive: true })
    await fs.writeFile(
      path.join(daemonsDir(), 'elsewhere.json'),
      JSON.stringify({
        project: 'elsewhere',
        projectPath: path.join(home, 'elsewhere-repo'),
        pid: process.pid, // a live pid → live:true
        status: 'running',
        ports: { rest: 8091, otlp: 4329, web: 6329 },
        startedAt: new Date().toISOString(),
        neatVersion: '0.6.3',
      }),
    )
    const res = await app.inject({ method: 'GET', url: '/projects/elsewhere' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      project: { hostedHere: boolean }
      servedBy?: { path: string; restPort: number; live: boolean }
    }
    expect(body.project.hostedHere).toBe(false)
    expect(body.servedBy).toMatchObject({
      path: path.join(home, 'elsewhere-repo'),
      restPort: 8091,
      live: true,
    })
  })

  it('a data-route 404 for a non-hosted project points back at /projects', async () => {
    app = await buildMultiProjectApi()
    const res = await app.inject({ method: 'GET', url: '/projects/elsewhere/graph' })
    expect(res.statusCode).toBe(404)
    const body = res.json() as { error: string; hint?: string }
    expect(body.error).toBe('project not found')
    expect(body.hint).toMatch(/hostedHere/)
  })

  it('single-project mode reports its one project as hostedHere', async () => {
    const registry = new Projects()
    registry.set('solo', { graph: getGraph('solo'), paths: pathsForProject('solo', home) })
    app = await buildApi({
      projects: registry,
      singleProject: { name: 'solo', path: home },
    })
    const res = await app.inject({ method: 'GET', url: '/projects' })
    expect(res.statusCode).toBe(200)
    const entries = res.json() as { name: string; hostedHere: boolean }[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'solo', hostedHere: true })
  })
})
