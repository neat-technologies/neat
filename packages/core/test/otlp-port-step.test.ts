import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import type { NeatGraph } from '../src/graph.js'
import { readDaemonRecord } from '../src/daemon.js'
import { startWatch } from '../src/watch.js'

// Daemon robustness (breaker round 2, refs #621):
//  1. A held OTLP receiver port steps to the next free one instead of crashing
//     the daemon — `:4318` is the OS-default OTLP port a foreign collector
//     commonly holds, and every consumer resolves the port back from
//     daemon.json, so stepping keeps the OBSERVED layer alive.
//  2. `neat watch` writes daemon.json with the port it actually bound, so an
//     instrumented app's otel-init resolves the right (non-default / stepped)
//     OTLP port instead of falling back to :4318.

// Grab a real free port, then hand it back — used to pick a non-default port
// nothing else is holding.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

// Hold a port open on 127.0.0.1 so a bind against it collides (EADDRINUSE).
function holdPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

function makeGraph(): NeatGraph {
  return new MultiDirectedGraph({ allowSelfLoops: false }) as unknown as NeatGraph
}

// Spawning a real daemon/watch here means a Fastify listen plus a default-
// project extraction pass, which legitimately takes seconds — and on a loaded
// machine one spawn has been seen to take ~23s. Vitest's default 5s per-test
// budget is far too tight for that, so these tests time out locally while
// passing on a clean CI runner (refs #818). Give the spawn a comfortable cap.
const SPAWN_TIMEOUT_MS = 60_000

// A freshly-bound OTLP receiver can take a beat to start answering, so poll
// /health until it reports 200 rather than betting the first request lands.
// The cap is generous so a busy machine still gets there; if it never does,
// re-throw the last failure so the assertion points at the real problem.
async function waitForHealthy(url: string, capMs = 30_000): Promise<Response> {
  const deadline = Date.now() + capMs
  let lastErr: unknown
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.status === 200) return res
      lastErr = new Error(`health check ${url} returned ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    if (Date.now() >= deadline) throw lastErr
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('OTLP port stepping + watch daemon.json (refs #621)', () => {
  const pending: Array<() => Promise<void> | void> = []
  const savedEnv = new Map<string, string | undefined>()
  for (const k of ['NEAT_HOME', 'PORT', 'OTEL_PORT', 'HOST', 'NEAT_AUTH_TOKEN']) {
    savedEnv.set(k, process.env[k])
  }

  afterEach(async () => {
    for (const c of pending.splice(0).reverse()) await c()
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  async function projectDir(name: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `neat-621-${name}-`))
    const real = await fs.realpath(dir)
    await fs.writeFile(
      path.join(real, 'package.json'),
      JSON.stringify({ name, version: '0.0.0' }),
    )
    pending.push(() => fs.rm(real, { recursive: true, force: true }))
    return real
  }

  it('a held OTLP receiver port steps to a free one instead of crashing the daemon', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-621-home-'))
    pending.push(() => fs.rm(home, { recursive: true, force: true }))
    process.env.NEAT_HOME = home
    process.env.HOST = '127.0.0.1'
    delete process.env.NEAT_AUTH_TOKEN

    const held = await freePort()
    const blocker = await holdPort(held)
    pending.push(() => new Promise<void>((r) => blocker.close(() => r())))

    const projPath = await projectDir('step-svc')
    const { addProject } = await import('../src/registry.js')
    await addProject({ name: 'step-svc', path: projPath, languages: ['javascript'] })

    const { startDaemon } = await import('../src/daemon.js')
    // REST on an ephemeral port; OTLP is asked for the held port on purpose.
    const daemon = await startDaemon({
      project: 'step-svc',
      projectPath: projPath,
      restPort: 0,
      otlpPort: held,
    })
    pending.push(daemon.stop)
    await daemon.initialBootstrap

    // The daemon came up rather than dying on EADDRINUSE, and it bound OTLP on
    // a different port than the held one.
    const boundOtlp = daemon.daemonRecord!.ports.otlp
    expect(boundOtlp).not.toBe(held)
    expect(boundOtlp).toBeGreaterThan(held)

    // The receiver is live on the stepped port, and daemon.json points there.
    const res = await waitForHealthy(`${daemon.otlpAddress}/health`)
    expect(res.status).toBe(200)
    expect(daemon.otlpAddress).toBe(`http://127.0.0.1:${boundOtlp}`)

    const record = await readDaemonRecord(projPath)
    expect(record!.ports.otlp).toBe(boundOtlp)
  }, SPAWN_TIMEOUT_MS)

  it('neat watch writes daemon.json carrying the real (non-default) bound OTLP port', async () => {
    const projPath = await projectDir('watch-svc')
    const outPath = path.join(projPath, 'neat-out', 'graph.json')
    const otelPort = await freePort() // a real, non-default port (not 4318)
    expect(otelPort).not.toBe(4318)

    const handle = await startWatch(makeGraph(), {
      scanPath: projPath,
      outPath,
      errorsPath: path.join(projPath, 'neat-out', 'errors.ndjson'),
      staleEventsPath: path.join(projPath, 'neat-out', 'stale.ndjson'),
      project: 'watch-svc',
      host: '127.0.0.1',
      port: 0,
      otelPort,
    })
    pending.push(handle.stop)

    // The record landed at the project root with the port watch actually bound
    // — not the default :4318 the app would otherwise fall back to.
    const record = await readDaemonRecord(projPath)
    expect(record).not.toBeNull()
    expect(record!.project).toBe('watch-svc')
    expect(record!.status).toBe('running')
    expect(record!.ports.otlp).toBe(otelPort)

    // And the receiver is genuinely listening on the recorded port.
    const res = await waitForHealthy(`http://127.0.0.1:${record!.ports.otlp}/health`)
    expect(res.status).toBe(200)
  }, SPAWN_TIMEOUT_MS)

  it('neat watch steps its OTLP bind off a held port and records the stepped one', async () => {
    const projPath = await projectDir('watch-step-svc')
    const outPath = path.join(projPath, 'neat-out', 'graph.json')
    const held = await freePort()
    const blocker = await holdPort(held)
    pending.push(() => new Promise<void>((r) => blocker.close(() => r())))

    const handle = await startWatch(makeGraph(), {
      scanPath: projPath,
      outPath,
      errorsPath: path.join(projPath, 'neat-out', 'errors.ndjson'),
      staleEventsPath: path.join(projPath, 'neat-out', 'stale.ndjson'),
      project: 'watch-step-svc',
      host: '127.0.0.1',
      port: 0,
      otelPort: held,
    })
    pending.push(handle.stop)

    const record = await readDaemonRecord(projPath)
    expect(record!.ports.otlp).not.toBe(held)
    expect(record!.ports.otlp).toBeGreaterThan(held)
    const res = await waitForHealthy(`http://127.0.0.1:${record!.ports.otlp}/health`)
    expect(res.status).toBe(200)
  }, SPAWN_TIMEOUT_MS)

  it('watch clears its daemon.json record to stopped on shutdown', async () => {
    const projPath = await projectDir('watch-stop-svc')
    const outPath = path.join(projPath, 'neat-out', 'graph.json')
    const handle = await startWatch(makeGraph(), {
      scanPath: projPath,
      outPath,
      errorsPath: path.join(projPath, 'neat-out', 'errors.ndjson'),
      staleEventsPath: path.join(projPath, 'neat-out', 'stale.ndjson'),
      project: 'watch-stop-svc',
      host: '127.0.0.1',
      port: 0,
      otelPort: 0,
    })
    expect((await readDaemonRecord(projPath))!.status).toBe('running')
    await handle.stop()
    expect((await readDaemonRecord(projPath))!.status).toBe('stopped')
  }, SPAWN_TIMEOUT_MS)
})
