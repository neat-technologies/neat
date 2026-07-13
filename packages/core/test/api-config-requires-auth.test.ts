import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'

// ADR-139 — `/api/config` gains `requiresAuth`, separating "no login required"
// from "read-only". `requiresAuth` is true iff the daemon actually mounts a
// bearer hook (`mountBearerAuth`'s own condition: a token is set and we're not
// trusting an upstream proxy). A tokenless daemon serves every request
// anonymously, so it reports `requiresAuth: false` and the web must not push
// the operator to /login. `publicRead` keeps its own meaning untouched.

const AUTH_VARS = ['NEAT_AUTH_TOKEN', 'NEAT_AUTH_PROXY', 'NEAT_PUBLIC_READ', 'NEAT_OTEL_TOKEN'] as const

describe('ADR-139 — /api/config requiresAuth signal', () => {
  let app: FastifyInstance | undefined
  let saved: Partial<Record<(typeof AUTH_VARS)[number], string | undefined>>

  beforeEach(() => {
    // Clear the auth env so a value inherited from the shell can't leak into the
    // `opts.x ?? env.x` fallbacks and make a scenario non-deterministic.
    saved = {}
    for (const k of AUTH_VARS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    resetGraph()
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
    for (const k of AUTH_VARS) {
      const v = saved[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  async function readConfig(opts: {
    authToken?: string
    trustProxy?: boolean
    publicRead?: boolean
  }): Promise<{ publicRead: boolean; authProxy: boolean; requiresAuth: boolean }> {
    const graph = getGraph()
    app = await buildApi({ graph, scanPath: process.cwd(), ...opts })
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('a tokenless daemon reports requiresAuth:false (nothing to log in with)', async () => {
    const body = await readConfig({})
    expect(body).toEqual({ publicRead: false, authProxy: false, requiresAuth: false })
  })

  it('a token-gated daemon reports requiresAuth:true', async () => {
    const body = await readConfig({ authToken: 'secret' })
    expect(body).toEqual({ publicRead: false, authProxy: false, requiresAuth: true })
  })

  it('public-read still requires auth for writes: publicRead:true, requiresAuth:true', async () => {
    // A NEAT_PUBLIC_READ reference deployment serves anonymous reads but keeps
    // the bearer on writes — so it both renders read-only *and* requires auth.
    const body = await readConfig({ authToken: 'secret', publicRead: true })
    expect(body).toEqual({ publicRead: true, authProxy: false, requiresAuth: true })
  })

  it('a proxy-terminated daemon reports requiresAuth:false (proxy already authed)', async () => {
    const body = await readConfig({ authToken: 'secret', trustProxy: true })
    expect(body).toEqual({ publicRead: false, authProxy: true, requiresAuth: false })
  })

  it('the surface stays exactly three booleans, nothing else', async () => {
    const body = await readConfig({ authToken: 'secret' })
    expect(Object.keys(body).sort()).toEqual(['authProxy', 'publicRead', 'requiresAuth'])
  })
})
