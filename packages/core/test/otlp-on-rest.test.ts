import { afterEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { promises as fs } from 'node:fs'

// #1290 — a hosted tenant runs behind a platform that routes one port, and that
// port is REST. The OTLP receiver lived only on its own listener, so an app
// exporting to the tenant's URL got a 401 or a 404 and the OBSERVED layer never
// filled. `/v1/traces` now answers on the REST listener as well.
//
// What has to hold on that second door:
//   - a span posted with the ingest token lands as an OBSERVED edge;
//   - the two tokens stay separate — the graph token does not open ingest, and
//     the ingest token does not open the graph (one-command-cli.md §4);
//   - it is the same receiver, so gzip and the project-scoped route behave as
//     they do on the OTLP port;
//   - the OTLP port itself is unchanged.
//
// Isolation: ephemeral ports, a throwaway NEAT_HOME, loopback.

const AUTH = 'graph-token-for-this-test'
const OTEL = 'ingest-token-for-this-test'
const ENV_KEYS = [
  'NEAT_HOME',
  'PORT',
  'OTEL_PORT',
  'HOST',
  'NEAT_AUTH_TOKEN',
  'NEAT_OTEL_TOKEN',
  'NEAT_AUTH_PROXY',
  'NEAT_PUBLIC_READ',
  'NEAT_PROJECT',
  'NEAT_PROJECT_PATH',
  'NEAT_WEB_PORT',
  'NEAT_WEB_DISABLED',
]

const pending: Array<() => Promise<void>> = []
afterEach(async () => {
  while (pending.length > 0) await pending.pop()!().catch(() => {})
})

interface Tenant {
  rest: string
  otlp: string
  graph: { edges: () => string[]; getEdgeAttributes: (e: string) => Record<string, unknown> }
  home: string
}

async function startTenant(tokens: { auth?: string; otel?: string }): Promise<Tenant> {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]] as const))
  for (const k of ENV_KEYS) delete process.env[k]
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-otlp-rest-home-'))
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-otlp-rest-proj-')))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'tenant-app', version: '0.0.0' }))
  process.env.NEAT_HOME = home
  process.env.HOST = '127.0.0.1'
  process.env.NEAT_WEB_DISABLED = '1'
  if (tokens.auth) process.env.NEAT_AUTH_TOKEN = tokens.auth
  if (tokens.otel) process.env.NEAT_OTEL_TOKEN = tokens.otel

  const { startDaemon } = await import('../src/daemon.js')
  const daemon = await startDaemon({ project: 'tenant-app', projectPath: dir, restPort: 0, otlpPort: 0 })
  pending.push(async () => {
    await daemon.stop()
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(dir, { recursive: true, force: true })
  })
  await daemon.initialBootstrap
  return {
    rest: daemon.restAddress,
    otlp: daemon.otlpAddress,
    graph: daemon.slots.get('tenant-app')!.graph as unknown as Tenant['graph'],
    home,
  }
}

function spanBody(host: string, spanId: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'tenant-app' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aabbccddeeff00112233445566778899',
                spanId,
                name: 'GET /upstream',
                kind: 3,
                startTimeUnixNano: '1770000000000000000',
                endTimeUnixNano: '1770000000050000000',
                attributes: [
                  { key: 'http.method', value: { stringValue: 'GET' } },
                  { key: 'server.address', value: { stringValue: host } },
                  { key: 'server.port', value: { intValue: '443' } },
                ],
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  })
}

function post(url: string, body: string | Buffer, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

// The OBSERVED edges that reach `host`, as `provenance source -> target`.
function observedTo(t: Tenant, host: string): string[] {
  return t.graph
    .edges()
    .map((e) => t.graph.getEdgeAttributes(e))
    .filter((a) => a.provenance === 'OBSERVED' && String(a.target).includes(host))
    .map((a) => `${a.provenance} ${a.source} -> ${a.target}`)
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

describe('OTLP on the REST listener (#1290)', () => {
  it('ingests a span posted to the REST port with the ingest token', async () => {
    const t = await startTenant({ auth: AUTH, otel: OTEL })
    const res = await post(`${t.rest}/v1/traces`, spanBody('payments.example.test', '1111111111111111'), bearer(OTEL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ partialSuccess: {} })

    expect(await waitFor(() => observedTo(t, 'payments.example.test').length > 0)).toBe(true)
    expect(observedTo(t, 'payments.example.test')).toEqual([
      'OBSERVED service:tenant-app -> frontier:payments.example.test',
    ])
  })

  it('keeps the two tokens separate on that door', async () => {
    const t = await startTenant({ auth: AUTH, otel: OTEL })
    const body = spanBody('nope.example.test', '2222222222222222')

    // The graph token is not an ingest credential.
    expect((await post(`${t.rest}/v1/traces`, body, bearer(AUTH))).status).toBe(401)
    // No token at all.
    expect((await post(`${t.rest}/v1/traces`, body)).status).toBe(401)
    // And the ingest token is not a graph credential.
    expect((await fetch(`${t.rest}/graph`, { headers: bearer(OTEL) })).status).toBe(401)
    expect((await fetch(`${t.rest}/graph`, { headers: bearer(AUTH) })).status).toBe(200)

    await new Promise((r) => setTimeout(r, 300))
    expect(observedTo(t, 'nope.example.test')).toEqual([])
  })

  it('falls back to the graph token for ingest when no ingest token is set', async () => {
    // One token set: it gates both surfaces, as it does on the OTLP port.
    const t = await startTenant({ auth: AUTH })
    const body = spanBody('single.example.test', '3333333333333333')
    expect((await post(`${t.rest}/v1/traces`, body)).status).toBe(401)
    expect((await post(`${t.rest}/v1/traces`, body, bearer(AUTH))).status).toBe(200)
    expect(await waitFor(() => observedTo(t, 'single.example.test').length > 0)).toBe(true)
  })

  it('is the same receiver: gzip, and the project-scoped route with its 404', async () => {
    const t = await startTenant({ auth: AUTH, otel: OTEL })

    const gz = zlib.gzipSync(Buffer.from(spanBody('gzip.example.test', '4444444444444444')))
    const gzRes = await post(`${t.rest}/v1/traces`, gz, { ...bearer(OTEL), 'content-encoding': 'gzip' })
    expect(gzRes.status).toBe(200)
    expect(await waitFor(() => observedTo(t, 'gzip.example.test').length > 0)).toBe(true)

    const scoped = await post(
      `${t.rest}/projects/tenant-app/v1/traces`,
      spanBody('scoped.example.test', '5555555555555555'),
      bearer(OTEL),
    )
    expect(scoped.status).toBe(200)
    expect(await waitFor(() => observedTo(t, 'scoped.example.test').length > 0)).toBe(true)

    const ghost = await post(
      `${t.rest}/projects/ghost/v1/traces`,
      spanBody('ghost.example.test', '6666666666666666'),
      bearer(OTEL),
    )
    expect(ghost.status).toBe(404)
    expect(await ghost.json()).toMatchObject({ error: 'project not found', project: 'ghost' })

    const bad = await post(`${t.rest}/v1/traces`, 'not otlp', { ...bearer(OTEL), 'content-type': 'text/plain' })
    expect(bad.status).toBe(415)
  })

  it('leaves the OTLP port as it was', async () => {
    const t = await startTenant({ auth: AUTH, otel: OTEL })
    const body = spanBody('direct.example.test', '7777777777777777')
    expect((await post(`${t.otlp}/v1/traces`, body)).status).toBe(401)
    expect((await post(`${t.otlp}/v1/traces`, body, bearer(AUTH))).status).toBe(401)
    expect((await post(`${t.otlp}/v1/traces`, body, bearer(OTEL))).status).toBe(200)
    expect(await waitFor(() => observedTo(t, 'direct.example.test').length > 0)).toBe(true)
  })

  it('is open on a tokenless loopback daemon, like the OTLP port', async () => {
    const t = await startTenant({})
    const res = await post(`${t.rest}/v1/traces`, spanBody('local.example.test', '8888888888888888'))
    expect(res.status).toBe(200)
    expect(await waitFor(() => observedTo(t, 'local.example.test').length > 0)).toBe(true)
  })

  it('does not exempt any other REST route from the graph token', async () => {
    const t = await startTenant({ auth: AUTH, otel: OTEL })
    // A path that merely looks like the ingest route is still a REST path.
    expect((await post(`${t.rest}/graph/v1/traces`, '{}', bearer(OTEL))).status).not.toBe(200)
    expect((await fetch(`${t.rest}/v1/traces`, { headers: bearer(OTEL) })).status).not.toBe(200)
  })
})
