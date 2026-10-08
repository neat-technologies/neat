import net from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpClient, HttpError, RequestTimeoutError } from '../src/client.js'

// The MCP surface has to stay queryable "at all times" — a daemon that has
// bound its port but isn't answering (mid-boot, wedged mid-extraction, behind a
// black-holing proxy) accepts the connection and then goes silent. Without a
// deadline the fetch only gives up at undici's 5-minute headers timeout, which
// is a hang from the agent's seat. These tests stand up real sockets rather
// than stubbing fetch, because the behaviour under test is the fetch deadline
// itself.

let blackhole: net.Server | undefined
let responsive: Server | undefined

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!blackhole) return resolve()
    blackhole.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    if (!responsive) return resolve()
    responsive.close(() => resolve())
  })
  blackhole = undefined
  responsive = undefined
})

// A server that accepts the TCP connection, swallows the request, and never
// writes a byte back. This is the wedged / mid-boot daemon.
async function startBlackhole(): Promise<number> {
  blackhole = net.createServer((sock) => {
    sock.on('data', () => {})
    sock.on('error', () => {})
  })
  await new Promise<void>((resolve) => blackhole!.listen(0, '127.0.0.1', resolve))
  return (blackhole!.address() as net.AddressInfo).port
}

async function startResponsive(): Promise<number> {
  responsive = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => responsive!.listen(0, '127.0.0.1', resolve))
  return (responsive!.address() as net.AddressInfo).port
}

describe('MCP createHttpClient request timeout', () => {
  it('rejects a wedged (accepts-but-never-responds) daemon within the deadline, not after 5 minutes', async () => {
    const port = await startBlackhole()
    const client = createHttpClient(`http://127.0.0.1:${port}`, undefined, 150)
    const t0 = Date.now()
    await expect(client.get('/graph/dependencies/service:x?depth=3')).rejects.toBeInstanceOf(
      RequestTimeoutError,
    )
    // Bounded: well under undici's default 5-minute headers timeout.
    expect(Date.now() - t0).toBeLessThan(3_000)
  })

  it('gives an agent-readable message naming the method, path, and the knob to raise', async () => {
    const port = await startBlackhole()
    const client = createHttpClient(`http://127.0.0.1:${port}`, undefined, 150)
    await client.get('/graph/divergences').then(
      () => expect.fail('expected a timeout'),
      (err: Error) => {
        expect(err).toBeInstanceOf(RequestTimeoutError)
        expect(err.message).toContain('GET /graph/divergences')
        expect(err.message).toContain('150ms')
        expect(err.message).toContain('NEAT_CORE_TIMEOUT_MS')
      },
    )
  })

  it('also bounds POST requests (dry-run / extend paths)', async () => {
    const port = await startBlackhole()
    const client = createHttpClient(`http://127.0.0.1:${port}`, undefined, 150)
    await expect(client.post!('/policies/check', { hypotheticalAction: null })).rejects.toBeInstanceOf(
      RequestTimeoutError,
    )
  })

  it('a connection-refused daemon still rejects fast — and is not misreported as a timeout', async () => {
    // Port 1 has nothing listening: the connection is refused, which is a
    // different failure than a wedged daemon and must not be dressed up as one.
    const client = createHttpClient('http://127.0.0.1:1', undefined, 5_000)
    const t0 = Date.now()
    await expect(client.get('/graph')).rejects.not.toBeInstanceOf(RequestTimeoutError)
    expect(Date.now() - t0).toBeLessThan(3_000)
  })

  it('a responsive daemon well inside the deadline returns normally', async () => {
    const port = await startResponsive()
    const client = createHttpClient(`http://127.0.0.1:${port}`, undefined, 5_000)
    await expect(client.get<{ ok: boolean }>('/health')).resolves.toEqual({ ok: true })
  })

  it('leaves real HTTP error statuses as HttpError, not timeouts', async () => {
    responsive = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'node not found' }))
    })
    await new Promise<void>((resolve) => responsive!.listen(0, '127.0.0.1', resolve))
    const port = (responsive.address() as net.AddressInfo).port
    const client = createHttpClient(`http://127.0.0.1:${port}`, undefined, 5_000)
    await expect(client.get('/graph/root-cause/service:x')).rejects.toBeInstanceOf(HttpError)
  })
})
