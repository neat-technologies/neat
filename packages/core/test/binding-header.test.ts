import { describe, expect, it, beforeEach } from 'vitest'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'

// §6 (docs/contracts/project-identity.md) — the daemon stamps the binding line
// on EVERY response as the `neat-binding` header. These drive buildApi through
// Fastify's inject and assert the header on a normal response, on an error
// response, and that it stays off when no identity is configured.
const LINE = 'project=newdryve (prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A) · binding=local · daemon=pid:4242'

describe('neat-binding response header (project-identity.md §6)', () => {
  beforeEach(() => {
    resetGraph()
  })

  it('stamps neat-binding on a normal (200) response when bindingHeader is set', async () => {
    const app = await buildApi({ graph: getGraph(), bindingHeader: LINE })
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['neat-binding']).toBe(LINE)
    } finally {
      await app.close()
    }
  })

  it('stamps neat-binding on an error (404) response too', async () => {
    const app = await buildApi({ graph: getGraph(), bindingHeader: LINE })
    try {
      const res = await app.inject({ method: 'GET', url: '/no-such-route' })
      expect(res.statusCode).toBe(404)
      expect(res.headers['neat-binding']).toBe(LINE)
    } finally {
      await app.close()
    }
  })

  it('omits the header when no bindingHeader is configured (legacy daemon)', async () => {
    const app = await buildApi({ graph: getGraph() })
    try {
      const res = await app.inject({ method: 'GET', url: '/api/config' })
      expect(res.headers['neat-binding']).toBeUndefined()
    } finally {
      await app.close()
    }
  })
})
