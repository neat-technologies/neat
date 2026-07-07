import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mountBearerAuth } from '../src/auth.js'

// #693 — mountBearerAuth's preHandler used to exempt a path via
// `path === suffix || path.endsWith(suffix)` against DEFAULT_UNAUTH_SUFFIXES
// (`/health`, `/healthz`, `/readyz`, `/api/config`). That means any future
// protected route that merely *ends* with one of those strings — say
// `/admin/health`, or a route someone names `.../api/config` for unrelated
// reasons — becomes accidentally unauthenticated. There was no dedicated test
// for mountBearerAuth's route matching before this file; cli-client-auth.test.ts
// covers the CLI client's bearer threading, not the matcher itself.

const TOKEN = 'test-bearer-693'

describe('mountBearerAuth — route matching (#693)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify({ logger: false })
    mountBearerAuth(app, { token: TOKEN })

    // The real unauthenticated probes.
    app.get('/health', async () => ({ ok: true }))
    app.get('/healthz', async () => ({ ok: true }))
    app.get('/readyz', async () => ({ ok: true }))
    app.get('/api/config', async () => ({ publicRead: false }))
    app.get('/projects/:project/health', async () => ({ ok: true }))

    // A hypothetical protected route. Its path happens to *end* with one of
    // the unauth suffixes above, but it is a different, unrelated resource —
    // it must stay gated. This is exactly the shape the audit called out.
    app.get('/admin/health', async () => ({ secret: 'do not leak' }))
    app.get('/v2/api/config', async () => ({ secret: 'do not leak' }))
    app.get('/projects/foo/bar/health', async () => ({ secret: 'do not leak' }))

    // An ordinary protected route, for the baseline bearer-check assertions.
    app.get('/graph', async () => ({ nodes: [], edges: [] }))

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('leaves the real unauth probes open with no bearer', async () => {
    for (const url of ['/health', '/healthz', '/readyz', '/api/config']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, `${url} should be reachable without a bearer`).toBe(200)
    }
  })

  it('leaves the project-scoped /projects/:project/health open with no bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/foo/health' })
    expect(res.statusCode).toBe(200)
  })

  it('keeps a route that merely ends with `/health` gated — does not treat it as a suffix match', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/admin/health' })
    expect(noAuth.statusCode).toBe(401)

    const withAuth = await app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(withAuth.statusCode).toBe(200)
  })

  it('keeps a route that merely ends with `/api/config` gated', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/v2/api/config' })
    expect(noAuth.statusCode).toBe(401)

    const withAuth = await app.inject({
      method: 'GET',
      url: '/v2/api/config',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(withAuth.statusCode).toBe(200)
  })

  it('keeps a route with an extra segment past the project-scoped probe gated (not just a prefix match)', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/foo/bar/health' })
    expect(res.statusCode).toBe(401)
  })

  it('requires a valid bearer on an ordinary protected route', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/graph' })
    expect(noAuth.statusCode).toBe(401)

    const badAuth = await app.inject({
      method: 'GET',
      url: '/graph',
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(badAuth.statusCode).toBe(401)

    const goodAuth = await app.inject({
      method: 'GET',
      url: '/graph',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(goodAuth.statusCode).toBe(200)
  })
})
