import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'
import { extractFromDirectory } from '../src/extract.js'
import {
  createHttpClient,
  HttpError,
  resolveAuthToken,
  runBlastRadius,
  runRootCause,
} from '../src/cli-client.js'

// ADR-073 §3 — the CLI query verbs must thread the bearer through to a secured
// daemon. These tests stand up a real listening daemon with a token set and
// drive the same `createHttpClient` + verb path `runQueryVerb` uses, asserting
// a request with the bearer authenticates (not 401) and one without it 401s.

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const DEMO_PATH = path.resolve(__dirname, '../../../demo')
const TOKEN = 'test-bearer-414'

describe('CLI client bearer auth (ADR-073 §3)', () => {
  let app: FastifyInstance
  let baseUrl: string
  let prevFloor: string | undefined

  beforeAll(async () => {
    prevFloor = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0'
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    app = await buildApi({ graph, scanPath: DEMO_PATH, authToken: TOKEN })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    if (!addr || typeof addr === 'string') throw new Error('no listen address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await app.close()
    if (prevFloor === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prevFloor
  })

  it('resolveAuthToken reads NEAT_AUTH_TOKEN and drops empty values', () => {
    expect(resolveAuthToken({ NEAT_AUTH_TOKEN: 'abc' })).toBe('abc')
    expect(resolveAuthToken({ NEAT_AUTH_TOKEN: '' })).toBeUndefined()
    expect(resolveAuthToken({})).toBeUndefined()
  })

  it('a verb with the bearer authenticates against a secured daemon', async () => {
    const client = createHttpClient(baseUrl, TOKEN)
    // blast-radius on a real demo node — the verb resolves (200), never 401.
    const result = await runBlastRadius(client, { nodeId: 'service:service-a' })
    expect(result.summary).toBeTypeOf('string')
    expect(result.summary.length).toBeGreaterThan(0)
  })

  it('root-cause with the bearer reaches the daemon (no 401)', async () => {
    const client = createHttpClient(baseUrl, TOKEN)
    // Whatever the graph says, the request authenticated — a missing root
    // cause comes back as a 404-shaped summary, not an auth failure.
    const result = await runRootCause(client, { errorNode: 'service:service-a' })
    expect(result.summary).toBeTypeOf('string')
  })

  it('a verb without the bearer 401s', async () => {
    const client = createHttpClient(baseUrl)
    await expect(
      runBlastRadius(client, { nodeId: 'service:service-a' }),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('a raw GET without the bearer 401s; with it does not', async () => {
    const noAuth = createHttpClient(baseUrl)
    await expect(noAuth.get('/graph')).rejects.toBeInstanceOf(HttpError)
    await expect(noAuth.get('/graph')).rejects.toMatchObject({ status: 401 })

    const withAuth = createHttpClient(baseUrl, TOKEN)
    const graph = await withAuth.get<{ nodes: unknown[] }>('/graph')
    expect(Array.isArray(graph.nodes)).toBe(true)
  })
})
