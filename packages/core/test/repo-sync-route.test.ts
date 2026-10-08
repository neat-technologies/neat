import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { NodeType } from '@neat.is/types'
import { getGraph, resetGraph } from '../src/graph.js'
import { Projects, pathsForProject } from '../src/projects.js'
import { buildApi } from '../src/api.js'
import type { RepoSyncRequestResult } from '../src/connectors/hosted-repos.js'

// #1293 — `POST /repo-sync` (and `/projects/:project/repo-sync`): the control plane's way to say "a repo was
// just bound, resynced or pushed; sync now" instead of waiting for the five-minute timer.

let tmpDir: string

beforeEach(async () => {
  resetGraph()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-repo-sync-route-'))
  getGraph('acme').addNode('service:acme', {
    id: 'service:acme',
    type: NodeType.ServiceNode,
    name: 'acme',
    language: 'javascript',
  })
})

afterEach(async () => {
  resetGraph()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function registry(): Projects {
  const r = new Projects()
  r.set('acme', { paths: pathsForProject('acme', tmpDir) })
  return r
}

describe('POST /repo-sync', () => {
  it('starts a pass and answers 202 with what happened', async () => {
    let calls = 0
    const result: RepoSyncRequestResult = {
      status: 'started',
      lastPass: {
        listed: true,
        synced: 2,
        failed: 0,
        startedAt: '2026-09-30T15:00:00.000Z',
        finishedAt: '2026-09-30T15:00:40.000Z',
      },
    }
    const app = await buildApi({
      projects: registry(),
      repoSync: (name) => (name === 'acme' ? () => (calls++, result) : undefined),
    })
    const res = await app.inject({ method: 'POST', url: '/projects/acme/repo-sync' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ project: 'acme', ...result })
    expect(calls).toBe(1)

    // The daemon is the project, so the root form means the same one.
    const root = await app.inject({ method: 'POST', url: '/repo-sync' })
    expect(root.statusCode).toBe(202)
    expect(root.json().project).toBe('acme')
    expect(calls).toBe(2)
    await app.close()
  })

  it('reports a pass queued behind the one running', async () => {
    const app = await buildApi({ projects: registry(), repoSync: () => () => ({ status: 'queued' }) })
    const res = await app.inject({ method: 'POST', url: '/projects/acme/repo-sync' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ project: 'acme', status: 'queued' })
    await app.close()
  })

  it('is 404 on a daemon with no repo-sync, and says what to use instead', async () => {
    const app = await buildApi({ projects: registry() })
    const res = await app.inject({ method: 'POST', url: '/projects/acme/repo-sync' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'repo-sync is not running for this project', project: 'acme' })
    expect((res.json() as { hint: string }).hint).toContain('/graph/scan')
    await app.close()
  })

  it('is 404 for a project the daemon does not host, without touching the trigger', async () => {
    let calls = 0
    const app = await buildApi({ projects: registry(), repoSync: () => () => (calls++, { status: 'started' }) })
    const res = await app.inject({ method: 'POST', url: '/projects/ghost/repo-sync' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'project not found', project: 'ghost' })
    expect(calls).toBe(0)
    await app.close()
  })

  it('needs the daemon token — public-read does not open it', async () => {
    let calls = 0
    const app = await buildApi({
      projects: registry(),
      authToken: 'daemon-token',
      publicRead: true,
      repoSync: () => () => (calls++, { status: 'started' }),
    })
    const anon = await app.inject({ method: 'POST', url: '/projects/acme/repo-sync' })
    expect(anon.statusCode).toBe(401)
    const wrong = await app.inject({
      method: 'POST',
      url: '/projects/acme/repo-sync',
      headers: { authorization: 'Bearer nope' },
    })
    expect(wrong.statusCode).toBe(401)
    expect(calls).toBe(0)
    const ok = await app.inject({
      method: 'POST',
      url: '/projects/acme/repo-sync',
      headers: { authorization: 'Bearer daemon-token' },
    })
    expect(ok.statusCode).toBe(202)
    expect(calls).toBe(1)
    await app.close()
  })
})

// The whole path on a real daemon: hosted env set, a control plane that lists no bound repos, and the route
// making the daemon go back and ask it again.
describe('POST /repo-sync on a hosted daemon', () => {
  const ENV = ['NEAT_HOME', 'HOST', 'PORT', 'OTEL_PORT', 'NEAT_AUTH_TOKEN', 'NEAT_OTEL_TOKEN', 'NEAT_CP_URL',
    'NEAT_CP_PROJECT_ID', 'NEAT_PROJECT', 'NEAT_PROJECT_PATH', 'NEAT_WEB_DISABLED', 'NEAT_WEB_PORT']
  const pending: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (pending.length > 0) await pending.pop()!().catch(() => {})
  })

  it('makes the daemon re-read its bound repos from the control plane', async () => {
    const saved = new Map(ENV.map((k) => [k, process.env[k]] as const))
    for (const k of ENV) delete process.env[k]

    const listReads: string[] = []
    const cp = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/internal/projects/prj_1/repos') {
        listReads.push(String(req.headers.authorization))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('[]')
        return
      }
      // Hosted connectors ask the same control plane for their own list; none here.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
    })
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r))
    const cpUrl = `http://127.0.0.1:${(cp.address() as AddressInfo).port}`

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-repo-sync-home-'))
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-repo-sync-proj-')))
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'tenant', version: '0.0.0' }))
    Object.assign(process.env, {
      NEAT_HOME: home,
      HOST: '127.0.0.1',
      NEAT_WEB_DISABLED: '1',
      NEAT_AUTH_TOKEN: 'daemon-token',
      NEAT_CP_URL: cpUrl,
      NEAT_CP_PROJECT_ID: 'prj_1',
    })

    const { startDaemon } = await import('../src/daemon.js')
    const daemon = await startDaemon({ project: 'tenant', projectPath: dir, restPort: 0, otlpPort: 0 })
    pending.push(async () => {
      await daemon.stop()
      await new Promise<void>((r) => cp.close(() => r()))
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await fs.rm(home, { recursive: true, force: true })
      await fs.rm(dir, { recursive: true, force: true })
    })
    await daemon.initialBootstrap
    const until = async (n: number): Promise<void> => {
      const deadline = Date.now() + 10_000
      while (listReads.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    }
    await until(1)
    expect(listReads).toHaveLength(1) // the boot pass

    const res = await fetch(`${daemon.restAddress}/projects/tenant/repo-sync`, {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token' },
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { project: string; status: string }
    expect(body.project).toBe('tenant')
    expect(['started', 'queued']).toContain(body.status)

    await until(2)
    expect(listReads).toHaveLength(2)
    expect(listReads[1]).toBe('Bearer daemon-token')

    const anon = await fetch(`${daemon.restAddress}/projects/tenant/repo-sync`, { method: 'POST' })
    expect(anon.status).toBe(401)
    await new Promise((r) => setTimeout(r, 200))
    expect(listReads).toHaveLength(2)
  })
})
