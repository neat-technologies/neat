import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { ConnectorsStatusResponseSchema } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'
import {
  CONNECTOR_STALE_THRESHOLD_MS,
  recordConnectorPoll,
  resetConnectorStatus,
} from '../src/connectors/status.js'

// docs/contracts/rest-api.md + connectors.md §8 (ADR-136) — GET /:project/
// connectors: the project's configured connectors from ~/.neat/connectors.json,
// credentials redacted to their env-ref pointer, each with live poll health.

interface ConnectorEntryInput {
  id: string
  provider: string
  project?: string
  credential: string | Record<string, string>
  options?: Record<string, unknown>
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

describe('GET /connectors (connector status)', () => {
  let app: FastifyInstance
  let home: string

  async function writeConnectors(connectors: ConnectorEntryInput[]): Promise<void> {
    await fs.writeFile(
      path.join(home, 'connectors.json'),
      JSON.stringify({ version: 1, connectors }, null, 2),
    )
  }

  beforeEach(async () => {
    resetGraph()
    resetConnectorStatus()
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-conn-status-')))
    app = await buildApi({ graph: getGraph(), connectorsHome: home })
  })

  afterEach(async () => {
    await app.close()
    resetConnectorStatus()
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('returns an empty wrapped list when no connectors.json exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/connectors' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ connectors: [] })
  })

  it('lists a configured connector, credential redacted to its env-ref pointer, idle before any poll', async () => {
    await writeConnectors([
      { id: 'cf-prod', provider: 'cloudflare', credential: '$CF_TOKEN', options: { accountId: 'acct1' } },
    ])
    const res = await app.inject({ method: 'GET', url: '/connectors' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual({
      connectors: [
        {
          id: 'cf-prod',
          provider: 'cloudflare',
          credentialRef: '$CF_TOKEN',
          status: { state: 'idle', lastPollAt: null, lastOutcome: null, lastError: null, signalsLastPoll: 0 },
        },
      ],
    })
    const parsed = ConnectorsStatusResponseSchema.safeParse(body)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).toBe(true)
  })

  it('never resolves or leaks a credential value — only the pointer is returned', async () => {
    const secret = 'super-secret-token-value-do-not-leak'
    process.env.CF_TOKEN = secret
    try {
      await writeConnectors([
        { id: 'cf-prod', provider: 'cloudflare', credential: '$CF_TOKEN', options: { accountId: 'acct1' } },
      ])
      const res = await app.inject({ method: 'GET', url: '/connectors' })
      const raw = res.payload
      expect(res.json().connectors[0].credentialRef).toBe('$CF_TOKEN')
      // The resolved secret must appear nowhere in the serialized response.
      expect(raw).not.toContain(secret)
    } finally {
      delete process.env.CF_TOKEN
    }
  })

  it('redacts a plaintext literal to **** and a multi-field credential field-by-field', async () => {
    await writeConnectors([
      { id: 'sb-brief', provider: 'supabase', credential: 'literal-secret-here', options: { apiProjectRef: 'r' } },
      {
        id: 'fb-app',
        provider: 'firebase',
        credential: { projectId: '$FB_PROJECT', accessToken: '$FB_TOKEN' },
      },
    ])
    const body = (await app.inject({ method: 'GET', url: '/connectors' })).json()
    const byId = Object.fromEntries(body.connectors.map((c: { id: string }) => [c.id, c]))
    expect(byId['sb-brief'].credentialRef).toBe('****')
    expect(byId['fb-app'].credentialRef).toEqual({ projectId: '$FB_PROJECT', accessToken: '$FB_TOKEN' })
    // The plaintext literal is masked, never echoed.
    expect((await app.inject({ method: 'GET', url: '/connectors' })).payload).not.toContain('literal-secret-here')
  })

  it('reflects each derived poll state — healthy / error / stale — from the tracker', async () => {
    await writeConnectors([
      { id: 'healthy-one', provider: 'railway', credential: '$R', options: {} },
      { id: 'error-one', provider: 'railway', credential: '$R', options: {} },
      { id: 'stale-one', provider: 'railway', credential: '$R', options: {} },
      { id: 'idle-one', provider: 'railway', credential: '$R', options: {} },
    ])
    recordConnectorPoll('healthy-one', { outcome: 'ok', at: iso(0), signalsLastPoll: 7 })
    recordConnectorPoll('error-one', { outcome: 'error', at: iso(0), error: 'railway auth check returned HTTP 401' })
    recordConnectorPoll('stale-one', { outcome: 'ok', at: iso(-(CONNECTOR_STALE_THRESHOLD_MS + 60_000)), signalsLastPoll: 2 })

    const body = (await app.inject({ method: 'GET', url: '/connectors' })).json()
    const byId = Object.fromEntries(body.connectors.map((c: { id: string }) => [c.id, c]))
    expect(byId['healthy-one'].status.state).toBe('healthy')
    expect(byId['healthy-one'].status.signalsLastPoll).toBe(7)
    expect(byId['error-one'].status.state).toBe('error')
    expect(byId['error-one'].status.lastError).toBe('railway auth check returned HTTP 401')
    expect(byId['stale-one'].status.state).toBe('stale')
    expect(byId['idle-one'].status.state).toBe('idle')
  })

  it('is dual-mounted at /connectors and /projects/:project/connectors', async () => {
    await writeConnectors([{ id: 'cf-prod', provider: 'cloudflare', credential: '$CF_TOKEN', options: {} }])
    const root = await app.inject({ method: 'GET', url: '/connectors' })
    const scoped = await app.inject({ method: 'GET', url: '/projects/default/connectors' })
    expect(root.statusCode).toBe(200)
    expect(scoped.statusCode).toBe(200)
    expect(root.json()).toEqual(scoped.json())
  })

  it('filters to the project — a connector bound to another project is excluded, a project-less one is included', async () => {
    await writeConnectors([
      { id: 'mine', provider: 'railway', credential: '$R', options: {} }, // no project → matches default
      { id: 'default-bound', provider: 'railway', project: 'default', credential: '$R', options: {} },
      { id: 'elsewhere', provider: 'railway', project: 'other-project', credential: '$R', options: {} },
    ])
    const body = (await app.inject({ method: 'GET', url: '/connectors' })).json()
    const ids = body.connectors.map((c: { id: string }) => c.id).sort()
    expect(ids).toEqual(['default-bound', 'mine'])
  })
})
