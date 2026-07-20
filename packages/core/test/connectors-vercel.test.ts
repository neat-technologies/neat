import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  createVercelDrain,
  deleteVercelDrain,
  testVercelDrainDelivery,
} from '../src/connectors/vercel/index.js'
import {
  buildRegistration,
  deprovisionConnector,
  isPushProvider,
  loadConnectorRegistrations,
  provisionConnector,
  validateConnectorEntry,
} from '../src/connectors/registry.js'
import { resetJunctionRateLimiters } from '../src/connectors/junction.js'
import { readConnectorsConfig, upsertConnectorEntry, type ConnectorEntry } from '../src/connectors-config.js'
import { runConnectorCommand, type ConnectorCliDeps } from '../src/connector-cli.js'
import type { NeatGraph } from '../src/graph.js'

// docs/contracts/connectors.md §9 (push providers), ADR-146. Vercel is the
// connectors plane's first push provider: it provisions a Drain (POST /v1/drains)
// instead of exposing a poll(). Everything here runs against a fake `fetch`
// (the DI seam every connector shares) and a temp home — never a live account.

const tmpDirs: string[] = []

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-vercel-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return path.join(real, 'neat')
}

afterEach(async () => {
  resetJunctionRateLimiters()
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

// The sentinel body a route can return to force `res.json()` to throw — the
// shape-drift / non-JSON case the client must tolerate without crashing.
const NON_JSON = Symbol('non-json')

interface RouteReply {
  status: number
  body?: unknown
}

interface Recorded {
  method: string
  url: string
  body: Record<string, unknown> | undefined
}

// A fake Vercel Drains API. Routes by (method, path): the /v1/drains/test
// validate endpoint, DELETE /v1/drains/{id}, and POST /v1/drains create. Every
// call is recorded (method, url, parsed body) so a test can assert exactly what
// was sent — and that a credential never rode in the URL or a query param.
function vercelStub(routes: { create?: RouteReply; test?: RouteReply; delete?: RouteReply }): {
  fetch: typeof fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> | undefined
    try {
      body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    } catch {
      body = undefined
    }
    calls.push({ method, url: u, body })

    let reply: RouteReply | undefined
    if (u.includes('/v1/drains/test')) reply = routes.test
    else if (method === 'DELETE' && /\/v1\/drains\/[^?]+/.test(u)) reply = routes.delete
    else if (method === 'POST' && /\/v1\/drains(\?|$)/.test(u)) reply = routes.create
    reply = reply ?? { status: 200, body: {} }

    const statusText =
      reply.status === 200 ? 'OK' : reply.status === 404 ? 'Not Found' : reply.status === 401 ? 'Unauthorized' : 'Error'
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText,
      json: async () => {
        if (reply!.body === NON_JSON) throw new Error('invalid json')
        return reply!.body ?? {}
      },
    } as Response
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

const CONFIG = { teamId: 'team_x', endpoint: 'https://neat.example.com/v1/traces', apiBaseUrl: 'https://api.vercel.test' }
const CREDS = { token: 'vercel-token', otelToken: 'otel-bearer' }

// ── client ───────────────────────────────────────────────────────────────

describe('vercel Drains client', () => {
  it('createVercelDrain sends the trace-schema OTLP drain body and returns the id', async () => {
    const stub = vercelStub({ create: { status: 200, body: { id: 'drn_1', status: 'enabled' } } })
    const created = await createVercelDrain({ ...CONFIG, projectIds: ['prj_a'] }, CREDS, stub.fetch)

    expect(created).toEqual({ id: 'drn_1', status: 'enabled' })
    const call = stub.calls[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toBe('https://api.vercel.test/v1/drains?teamId=team_x')
    expect(call.body).toMatchObject({
      projects: 'some',
      projectIds: ['prj_a'],
      schemas: { trace: { version: 'v1' } },
      source: { kind: 'self-served' },
      delivery: { type: 'http', encoding: 'json', endpoint: 'https://neat.example.com/v1/traces' },
    })
    // The daemon's OTLP bearer travels in the delivery header, never the URL.
    expect((call.body!.delivery as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer otel-bearer')
    expect(call.url).not.toContain('otel-bearer')
    expect(call.url).not.toContain('vercel-token')
  })

  it('createVercelDrain defaults to projects:all when no projectIds are given', async () => {
    const stub = vercelStub({ create: { status: 200, body: { id: 'drn_2' } } })
    await createVercelDrain(CONFIG, CREDS, stub.fetch)
    expect(stub.calls[0]!.body).toMatchObject({ projects: 'all' })
    expect(stub.calls[0]!.body!.projectIds).toBeUndefined()
  })

  it('createVercelDrain throws on a non-2xx, surfacing the Vercel error message', async () => {
    const stub = vercelStub({ create: { status: 402, body: { error: { message: 'Drains require a Pro plan' } } } })
    await expect(createVercelDrain(CONFIG, CREDS, stub.fetch)).rejects.toThrow(/402.*Drains require a Pro plan/)
  })

  it('createVercelDrain throws when the response carries no id (shape drift)', async () => {
    const stub = vercelStub({ create: { status: 200, body: { notAnId: true } } })
    await expect(createVercelDrain(CONFIG, CREDS, stub.fetch)).rejects.toThrow(/no drain id/)
  })

  it('createVercelDrain throws (not crashes) on a 200 with a non-JSON body', async () => {
    const stub = vercelStub({ create: { status: 200, body: NON_JSON } })
    await expect(createVercelDrain(CONFIG, CREDS, stub.fetch)).rejects.toThrow(/no drain id/)
  })

  it('deleteVercelDrain treats 404 as an idempotent success', async () => {
    const stub = vercelStub({ delete: { status: 404, body: { error: { message: 'not found' } } } })
    await expect(deleteVercelDrain(CONFIG, 'drn_gone', CREDS, stub.fetch)).resolves.toBeUndefined()
    expect(stub.calls[0]!.method).toBe('DELETE')
    expect(stub.calls[0]!.url).toBe('https://api.vercel.test/v1/drains/drn_gone?teamId=team_x')
  })

  it('deleteVercelDrain throws on a real failure (500)', async () => {
    const stub = vercelStub({ delete: { status: 500 } })
    await expect(deleteVercelDrain(CONFIG, 'drn_1', CREDS, stub.fetch)).rejects.toThrow(/delete drain failed/)
  })

  it('testVercelDrainDelivery maps a reachable endpoint to success', async () => {
    const stub = vercelStub({ test: { status: 200, body: { status: 'success' } } })
    await expect(testVercelDrainDelivery(CONFIG, CREDS, stub.fetch)).resolves.toEqual({ status: 'success' })
  })

  it('testVercelDrainDelivery surfaces a reachable-but-failing endpoint verbatim', async () => {
    const stub = vercelStub({
      test: { status: 200, body: { status: 'failure', error: 'Your endpoint could not be reached', endpoint: 'x' } },
    })
    const result = await testVercelDrainDelivery(CONFIG, CREDS, stub.fetch)
    expect(result.status).toBe('failure')
    expect(result.error).toMatch(/could not be reached/)
  })

  it('testVercelDrainDelivery maps a rejected API token (401) to a distinct failure', async () => {
    const stub = vercelStub({ test: { status: 401 } })
    const result = await testVercelDrainDelivery(CONFIG, CREDS, stub.fetch)
    expect(result.status).toBe('failure')
    expect(result.error).toMatch(/rejected the API token/)
  })
})

// ── registry: push dispatch ────────────────────────────────────────────────

function vercelEntry(overrides: Partial<ConnectorEntry> = {}): ConnectorEntry {
  return {
    id: 'vercel',
    provider: 'vercel',
    credential: { token: '$VERCEL_TOKEN', otelToken: '$NEAT_OTEL_TOKEN' },
    options: { teamId: 'team_x', endpoint: 'https://neat.example.com/v1/traces', apiBaseUrl: 'https://api.vercel.test' },
    ...overrides,
  }
}

// Distinctive so a "secret never at rest" assertion can't false-positive on an
// incidental two-letter substring.
const ENV = { VERCEL_TOKEN: 'VERCEL-SECRET-9f3a', NEAT_OTEL_TOKEN: 'OTEL-SECRET-7b2c' }

describe('vercel push dispatch (registry)', () => {
  it('is registered as a push provider, not a pull one', () => {
    expect(isPushProvider('vercel')).toBe(true)
    expect(isPushProvider('supabase')).toBe(false)
  })

  it('provisionConnector creates the drain and returns the id to store', async () => {
    const stub = vercelStub({ create: { status: 200, body: { id: 'drn_9', status: 'enabled' } } })
    const outcome = await provisionConnector(vercelEntry(), ENV, stub.fetch)
    expect(outcome).toEqual({ status: 'ok', options: { drainId: 'drn_9' } })
  })

  it('provisionConnector notes a created-but-disabled drain without failing', async () => {
    const stub = vercelStub({
      create: { status: 200, body: { id: 'drn_10', status: 'disabled', disabledReason: 'feature-not-available' } },
    })
    const outcome = await provisionConnector(vercelEntry(), ENV, stub.fetch)
    expect(outcome.status).toBe('ok')
    expect(outcome.status === 'ok' && outcome.options).toEqual({ drainId: 'drn_10' })
    expect(outcome.status === 'ok' && outcome.note).toMatch(/disabled/)
  })

  it('provisionConnector reports an unset env-ref distinctly, and never calls the API', async () => {
    const stub = vercelStub({ create: { status: 200, body: { id: 'x' } } })
    const outcome = await provisionConnector(vercelEntry(), {}, stub.fetch)
    expect(outcome.status).toBe('unset-env')
    expect(stub.calls).toHaveLength(0)
  })

  it('deprovisionConnector deletes the recorded drain', async () => {
    const stub = vercelStub({ delete: { status: 200, body: {} } })
    const outcome = await deprovisionConnector(vercelEntry({ options: { teamId: 'team_x', endpoint: 'https://e/v1/traces', apiBaseUrl: 'https://api.vercel.test', drainId: 'drn_9' } }), ENV, stub.fetch)
    expect(outcome.status).toBe('ok')
    expect(stub.calls[0]!.url).toContain('/v1/drains/drn_9')
  })

  it('deprovisionConnector with no recorded drainId is a no-op success', async () => {
    const stub = vercelStub({ delete: { status: 200 } })
    const outcome = await deprovisionConnector(vercelEntry(), ENV, stub.fetch)
    expect(outcome.status).toBe('ok')
    expect(stub.calls).toHaveLength(0)
  })

  it('validateConnectorEntry runs the drain-delivery test for a vercel entry', async () => {
    const ok = vercelStub({ test: { status: 200, body: { status: 'success' } } })
    await expect(validateConnectorEntry(vercelEntry(), ENV, ok.fetch)).resolves.toEqual({ status: 'ok' })

    const bad = vercelStub({ test: { status: 200, body: { status: 'failure', error: 'unreachable' } } })
    const outcome = await validateConnectorEntry(vercelEntry(), ENV, bad.fetch)
    expect(outcome).toEqual({ status: 'rejected', reason: 'unreachable' })
  })

  it('buildRegistration skips a vercel entry benignly — no poll registration', () => {
    const result = buildRegistration(vercelEntry(), {} as unknown as NeatGraph, ENV)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.push).toBe(true)
  })

  it('loadConnectorRegistrations produces nothing for vercel and never fires onSkip', async () => {
    const home = await makeHome()
    await upsertConnectorEntry(vercelEntry({ options: { teamId: 'team_x', endpoint: 'https://e/v1/traces', drainId: 'drn_1' } }), home)
    const skips: string[] = []
    const regs = await loadConnectorRegistrations({
      project: 'anything',
      graph: {} as unknown as NeatGraph,
      home,
      env: ENV,
      onSkip: (entry) => skips.push(entry.id),
    })
    expect(regs).toHaveLength(0)
    expect(skips).toHaveLength(0)
  })
})

// ── CLI: add / remove / test ────────────────────────────────────────────────

interface Captured {
  out: string[]
  err: string[]
  code: number
}

async function run(args: string[], deps: Partial<ConnectorCliDeps>): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const code = await runConnectorCommand(args, {
    interactive: false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...deps,
  })
  return { out, err, code }
}

const ADD_VERCEL = [
  'add',
  'vercel',
  '--token',
  '$VERCEL_TOKEN',
  '--otel-token',
  '$NEAT_OTEL_TOKEN',
  '--team-id',
  'team_x',
  '--endpoint',
  'https://neat.example.com/v1/traces',
  '--api-base-url',
  'https://api.vercel.test',
]

describe('neat connector add/remove/test — vercel', () => {
  it('add provisions the drain, stores the drainId, and stores creds as env-ref pointers', async () => {
    const home = await makeHome()
    const stub = vercelStub({ create: { status: 200, body: { id: 'drn_live', status: 'enabled' } } })
    const res = await run(ADD_VERCEL, { home, env: ENV, fetchImpl: stub.fetch })

    expect(res.code).toBe(0)
    expect(res.out.join('\n')).toMatch(/drain is live/i)
    const config = await readConnectorsConfig(home)
    const entry = config.connectors.find((c) => c.id === 'vercel')!
    expect(entry.options).toMatchObject({ teamId: 'team_x', drainId: 'drn_live' })
    // Never the resolved secret at rest — the pointer only (contract §2/§6).
    expect(entry.credential).toEqual({ token: '$VERCEL_TOKEN', otelToken: '$NEAT_OTEL_TOKEN' })
    expect(JSON.stringify(config)).not.toContain('VERCEL-SECRET-9f3a')
    expect(JSON.stringify(config)).not.toContain('OTEL-SECRET-7b2c')
  })

  it('add writes nothing when provisioning fails', async () => {
    const home = await makeHome()
    const stub = vercelStub({ create: { status: 402, body: { error: { message: 'upgrade to Pro' } } } })
    const res = await run(ADD_VERCEL, { home, env: ENV, fetchImpl: stub.fetch })

    expect(res.code).toBe(1)
    expect(res.err.join('\n')).toMatch(/could not provision.*upgrade to Pro/)
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(0)
  })

  it('remove deletes the drain before dropping the entry', async () => {
    const home = await makeHome()
    const addStub = vercelStub({ create: { status: 200, body: { id: 'drn_del', status: 'enabled' } } })
    await run(ADD_VERCEL, { home, env: ENV, fetchImpl: addStub.fetch })

    const rmStub = vercelStub({ delete: { status: 200, body: {} } })
    const res = await run(['remove', 'vercel'], { home, env: ENV, fetchImpl: rmStub.fetch })

    expect(res.code).toBe(0)
    expect(rmStub.calls[0]!.method).toBe('DELETE')
    expect(rmStub.calls[0]!.url).toContain('/v1/drains/drn_del')
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(0)
  })

  it('remove keeps the entry if the drain deletion fails, so it can be retried', async () => {
    const home = await makeHome()
    const addStub = vercelStub({ create: { status: 200, body: { id: 'drn_keep', status: 'enabled' } } })
    await run(ADD_VERCEL, { home, env: ENV, fetchImpl: addStub.fetch })

    const rmStub = vercelStub({ delete: { status: 500 } })
    const res = await run(['remove', 'vercel'], { home, env: ENV, fetchImpl: rmStub.fetch })

    expect(res.code).toBe(1)
    expect(res.err.join('\n')).toMatch(/could not delete.*drain/)
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(1)
  })

  it('test re-runs the drain-delivery check for an existing vercel connector', async () => {
    const home = await makeHome()
    const addStub = vercelStub({ create: { status: 200, body: { id: 'drn_t', status: 'enabled' } } })
    await run(ADD_VERCEL, { home, env: ENV, fetchImpl: addStub.fetch })

    const okStub = vercelStub({ test: { status: 200, body: { status: 'success' } } })
    const res = await run(['test', 'vercel'], { home, env: ENV, fetchImpl: okStub.fetch })
    expect(res.code).toBe(0)
    expect(okStub.calls[0]!.url).toContain('/v1/drains/test')
  })

  // Papercuts the first blind run surfaced: `--help` errored ("requires a
  // value") and `--json` wasn't recognized on the connector command.
  it('--help prints usage and exits 0 (with or without a subcommand)', async () => {
    const bare = await run(['--help'], {})
    expect(bare.code).toBe(0)
    expect(bare.out.join('\n')).toMatch(/usage: neat connector/)
    const onAdd = await run(['add', '--help'], {})
    expect(onAdd.code).toBe(0)
    expect(onAdd.out.join('\n')).toMatch(/vercel/)
  })

  it('list --json emits a machine-readable listing marking vercel as a push connector', async () => {
    const home = await makeHome()
    const addStub = vercelStub({ create: { status: 200, body: { id: 'drn_j', status: 'enabled' } } })
    await run(ADD_VERCEL, { home, env: ENV, fetchImpl: addStub.fetch })

    const res = await run(['list', '--json'], { home, env: ENV })
    expect(res.code).toBe(0)
    const rows = JSON.parse(res.out.join('\n')) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'vercel', provider: 'vercel', kind: 'push' })
    // Credentials stay redacted pointers in JSON too — no resolved secret.
    expect(JSON.stringify(rows)).not.toContain('VERCEL-SECRET-9f3a')
    expect(JSON.stringify(rows)).not.toContain('OTEL-SECRET-7b2c')
  })
})
