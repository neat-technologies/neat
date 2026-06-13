import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import {
  resolveWebPorts,
  readDaemonPorts,
  spawnWebUI,
  DEFAULT_WEB_PORT,
  DEFAULT_REST_PORT,
  type WebHandle,
} from '../src/web-spawn.js'

// ── helpers ───────────────────────────────────────────────────────────────

async function mkTmpProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-web-spawn-'))
  await fs.mkdir(path.join(dir, 'neat-out'), { recursive: true })
  return dir
}

async function writeDaemonJson(root: string, record: unknown): Promise<void> {
  await fs.writeFile(path.join(root, 'neat-out', 'daemon.json'), JSON.stringify(record), 'utf8')
}

// Pick a free port to use as the dashboard port in a test, so we never touch
// the canonical 6328 a live daemon might hold.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (addr && typeof addr === 'object') {
        const p = addr.port
        s.close(() => resolve(p))
      } else {
        s.close(() => reject(new Error('no port')))
      }
    })
  })
}

// A throwaway "web server" the test injects in place of the real Next
// standalone bundle. It binds the PORT it's handed and answers every request
// with the NEAT_API_URL it inherited, so the test can prove the env wiring and
// the proxy handoff without building Next.
async function writeStubServer(dir: string): Promise<string> {
  const entry = path.join(dir, 'stub-server.cjs')
  const src = `
const http = require('node:http')
const port = Number(process.env.PORT)
const apiUrl = process.env.NEAT_API_URL || ''
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('stub ' + apiUrl)
})
srv.listen(port, '127.0.0.1')
`
  await fs.writeFile(entry, src, 'utf8')
  return entry
}

function get(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}

const handles: WebHandle[] = []
const tmpDirs: string[] = []
const savedEnv = { ...process.env }

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop().catch(() => {})))
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
  )
  // Restore the env keys the suite touches so cases don't leak into each other.
  for (const k of ['NEAT_SCAN_PATH', 'NEAT_WEB_PORT', 'NEAT_API_URL']) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// ── resolveWebPorts (pure) ─────────────────────────────────────────────────

describe('resolveWebPorts — daemon.json is the source of truth (ADR-096 §2)', () => {
  it('prefers the daemon.json web/rest ports over every fallback', () => {
    const { webPort, apiUrl } = resolveWebPorts({
      daemonWeb: 6400,
      daemonRest: 8100,
      webPortEnv: '9999',
      apiUrlEnv: undefined,
      restPortArg: 8080,
    })
    expect(webPort).toBe(6400)
    expect(apiUrl).toBe('http://localhost:8100')
  })

  it('falls back to NEAT_WEB_PORT, then to the canonical 6328', () => {
    expect(
      resolveWebPorts({
        daemonWeb: null,
        daemonRest: null,
        webPortEnv: '6500',
        apiUrlEnv: undefined,
        restPortArg: 8080,
      }).webPort,
    ).toBe(6500)
    expect(
      resolveWebPorts({
        daemonWeb: null,
        daemonRest: null,
        webPortEnv: undefined,
        apiUrlEnv: undefined,
        restPortArg: 8080,
      }).webPort,
    ).toBe(DEFAULT_WEB_PORT)
  })

  it('points the API URL at the rest-port argument, then the canonical rest port', () => {
    expect(
      resolveWebPorts({
        daemonWeb: null,
        daemonRest: null,
        webPortEnv: undefined,
        apiUrlEnv: undefined,
        restPortArg: 8055,
      }).apiUrl,
    ).toBe('http://localhost:8055')
    expect(
      resolveWebPorts({
        daemonWeb: null,
        daemonRest: null,
        webPortEnv: undefined,
        apiUrlEnv: undefined,
        restPortArg: 0,
      }).apiUrl,
    ).toBe(`http://localhost:${DEFAULT_REST_PORT}`)
  })

  it('lets a pre-set NEAT_API_URL win (operator override)', () => {
    expect(
      resolveWebPorts({
        daemonWeb: null,
        daemonRest: 8100,
        webPortEnv: undefined,
        apiUrlEnv: 'http://example.test:1234',
        restPortArg: 8080,
      }).apiUrl,
    ).toBe('http://example.test:1234')
  })

  it('rejects a malformed NEAT_WEB_PORT loudly', () => {
    expect(() =>
      resolveWebPorts({
        daemonWeb: null,
        daemonRest: null,
        webPortEnv: 'not-a-port',
        apiUrlEnv: undefined,
        restPortArg: 8080,
      }),
    ).toThrow(/invalid NEAT_WEB_PORT/)
  })
})

// ── readDaemonPorts (fs, bulletproof) ──────────────────────────────────────

describe('readDaemonPorts — never throws on a bad or missing file', () => {
  it('reads the ports from a well-formed daemon.json', async () => {
    const root = await mkTmpProject()
    tmpDirs.push(root)
    await writeDaemonJson(root, {
      project: 'demo',
      ports: { rest: 8100, otlp: 4400, web: 6400 },
    })
    expect(await readDaemonPorts(root)).toEqual({ web: 6400, rest: 8100 })
  })

  it('returns nulls when the file is absent', async () => {
    const root = await mkTmpProject()
    tmpDirs.push(root)
    expect(await readDaemonPorts(root)).toEqual({ web: null, rest: null })
  })

  it('returns nulls when the JSON is malformed', async () => {
    const root = await mkTmpProject()
    tmpDirs.push(root)
    await fs.writeFile(path.join(root, 'neat-out', 'daemon.json'), '{ not json', 'utf8')
    expect(await readDaemonPorts(root)).toEqual({ web: null, rest: null })
  })

  it('drops out-of-range or non-numeric ports to null', async () => {
    const root = await mkTmpProject()
    tmpDirs.push(root)
    await writeDaemonJson(root, { ports: { rest: 'nope', web: 70000 } })
    expect(await readDaemonPorts(root)).toEqual({ web: null, rest: null })
  })
})

// ── spawnWebUI — binds the daemon.json port, spawns lazily ─────────────────

describe('spawnWebUI — per-project port + lazy spawn (ADR-096 §5, §7)', () => {
  it('binds the daemon.json web port and does not spawn until the dashboard is opened', async () => {
    const root = await mkTmpProject()
    tmpDirs.push(root)
    const webPort = await freePort()
    const restPort = 8137
    await writeDaemonJson(root, { project: 'demo', ports: { rest: restPort, web: webPort } })
    process.env.NEAT_SCAN_PATH = root
    delete process.env.NEAT_WEB_PORT
    delete process.env.NEAT_API_URL
    const serverEntry = await writeStubServer(root)

    const handle = await spawnWebUI(9090, { serverEntry, skipBuildCheck: true })
    handles.push(handle)

    // It bound the daemon.json web port, not the canonical 6328 and not the
    // restPort argument's worth of anything.
    expect(handle.port).toBe(webPort)
    // Nothing spawned yet — the daemon is up but nobody has looked at it.
    expect(handle.started()).toBe(false)
    expect(handle.child).toBe(null)

    // Open the dashboard. The first request triggers the real spawn and proxies
    // through; the stub answers with the API URL it inherited, proving the
    // daemon.json rest port wired the child's NEAT_API_URL.
    const res = await get(webPort)
    expect(res.status).toBe(200)
    expect(res.body).toBe(`stub http://localhost:${restPort}`)
    expect(handle.started()).toBe(true)
    expect(handle.child).not.toBe(null)
  })

  it('falls back to the canonical 6328 when daemon.json is missing', async () => {
    const root = await mkTmpProject()
    tmpDirs.push(root)
    process.env.NEAT_SCAN_PATH = root
    // Override NEAT_WEB_PORT so we bind a free test port, never the live 6328 —
    // but the point under test is that with no daemon.json we drop to env/canon.
    const webPort = await freePort()
    process.env.NEAT_WEB_PORT = String(webPort)
    delete process.env.NEAT_API_URL
    const serverEntry = await writeStubServer(root)

    const handle = await spawnWebUI(8080, { serverEntry, skipBuildCheck: true })
    handles.push(handle)
    expect(handle.port).toBe(webPort)
    expect(handle.started()).toBe(false)

    // And with neither daemon.json nor env, the resolver would land on 6328.
    expect(
      resolveWebPorts({
        daemonWeb: null,
        daemonRest: null,
        webPortEnv: undefined,
        apiUrlEnv: undefined,
        restPortArg: 8080,
      }).webPort,
    ).toBe(DEFAULT_WEB_PORT)
  })

  it('stop() closes the front listener and reaps the child', async () => {
    const root = await mkTmpProject()
    tmpDirs.push(root)
    const webPort = await freePort()
    await writeDaemonJson(root, { ports: { rest: 8080, web: webPort } })
    process.env.NEAT_SCAN_PATH = root
    delete process.env.NEAT_WEB_PORT
    const serverEntry = await writeStubServer(root)

    const handle = await spawnWebUI(8080, { serverEntry, skipBuildCheck: true })
    await get(webPort)
    expect(handle.started()).toBe(true)

    await handle.stop()
    // The port is free again — a fresh listener can bind it.
    await expect(
      new Promise<void>((resolve, reject) => {
        const s = net.createServer()
        s.once('error', reject)
        s.listen(webPort, '127.0.0.1', () => s.close(() => resolve()))
      }),
    ).resolves.toBeUndefined()
  })
})
