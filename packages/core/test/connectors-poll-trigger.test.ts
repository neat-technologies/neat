import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'
import { resetConnectorStatus } from '../src/connectors/status.js'
import type { ConnectorPollResult } from '../src/connectors/index.js'

// #871 — POST /connectors/:id/poll triggers one poll on demand so an operator
// can verify a freshly-added connector instead of waiting a full interval (or,
// before the poll loop wired up under `neat watch`, forever with no way to force
// or diagnose a tick). It reuses the same buildRegistration + runConnectorPoll
// the background loop uses; the outcome lands in the status tracker GET
// /connectors reads, so the manual and background surfaces agree. The poll
// executor is injected here so the trigger's wiring is verifiable without a live
// provider round-trip.

interface EntryInput {
  id: string
  provider: string
  project?: string
  credential: string | Record<string, string>
  options?: Record<string, unknown>
}

type RunPoll = NonNullable<Parameters<typeof buildApi>[0]['runPoll']>

describe('POST /connectors/:id/poll — manual trigger (#871)', () => {
  let app: FastifyInstance | undefined
  let home: string

  async function writeConnectors(connectors: EntryInput[]): Promise<void> {
    await fs.writeFile(path.join(home, 'connectors.json'), JSON.stringify({ version: 1, connectors }))
  }
  async function build(runPoll?: RunPoll): Promise<void> {
    app = await buildApi({ graph: getGraph(), connectorsHome: home, ...(runPoll ? { runPoll } : {}) })
  }
  const cf: EntryInput = {
    id: 'cf',
    provider: 'cloudflare',
    credential: '$CF_TOKEN',
    options: { accountId: 'a', workers: {} },
  }

  beforeEach(async () => {
    resetGraph()
    resetConnectorStatus()
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-conn-poll-')))
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
    resetConnectorStatus()
    delete process.env.CF_TOKEN
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('404s for an unknown connector id', async () => {
    await writeConnectors([cf])
    await build()
    const res = await app!.inject({ method: 'POST', url: '/connectors/nope/poll' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'connector not found', id: 'nope' })
  })

  it('409s for a push provider — its data arrives via OTLP, nothing to poll', async () => {
    await writeConnectors([{ id: 'v', provider: 'vercel', credential: '$V' }])
    await build()
    const res = await app!.inject({ method: 'POST', url: '/connectors/v/poll' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ id: 'v', push: true })
  })

  it('runs one poll and records the outcome the status tracker reports', async () => {
    process.env.CF_TOKEN = 't'
    await writeConnectors([cf])
    let called = 0
    const runPoll: RunPoll = async () => {
      called++
      return { signalCount: 5 } as unknown as ConnectorPollResult
    }
    await build(runPoll)
    const res = await app!.inject({ method: 'POST', url: '/connectors/cf/poll' })
    expect(res.statusCode).toBe(200)
    expect(called).toBe(1)
    expect(res.json()).toMatchObject({ id: 'cf', outcome: 'ok', signalsLastPoll: 5 })
    // The manual tick lands on GET /connectors, so both surfaces agree.
    const status = (await app!.inject({ method: 'GET', url: '/connectors' })).json()
    expect(status.connectors[0].status).toMatchObject({ state: 'healthy', signalsLastPoll: 5 })
  })

  it('502s and records an error when the poll throws', async () => {
    process.env.CF_TOKEN = 't'
    await writeConnectors([cf])
    const runPoll: RunPoll = async () => {
      throw new Error('provider rejected the credential')
    }
    await build(runPoll)
    const res = await app!.inject({ method: 'POST', url: '/connectors/cf/poll' })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ id: 'cf', outcome: 'error' })
    expect(typeof res.json().error).toBe('string')
    const status = (await app!.inject({ method: 'GET', url: '/connectors' })).json()
    expect(status.connectors[0].status.state).toBe('error')
  })

  it('is dual-mounted at /projects/:project/connectors/:id/poll', async () => {
    process.env.CF_TOKEN = 't'
    await writeConnectors([cf])
    const runPoll: RunPoll = async () => ({ signalCount: 1 }) as unknown as ConnectorPollResult
    await build(runPoll)
    const scoped = await app!.inject({ method: 'POST', url: '/projects/default/connectors/cf/poll' })
    expect(scoped.statusCode).toBe(200)
    expect(scoped.json()).toMatchObject({ id: 'cf', outcome: 'ok' })
  })
})
