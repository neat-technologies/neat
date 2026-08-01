import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { runMonitor } from '../src/monitor.js'

// End-to-end for the monitor (ADR-159): a real daemon, a real SSE connection,
// real OTLP spans, and the real divergence REST read — no mocks. A CLIENT span
// to an unresolved peer host mints an OBSERVED CALLS edge to a FrontierNode with
// no EXTRACTED twin, which is exactly a `missing-extracted` divergence
// (divergences.ts). So one span produces both an `edge-added` trigger and a
// fresh divergence — the two facts the monitor must turn into lines.
//
// Asserted here, against the live daemon:
//   1. an existing divergence prints once on the monitor's baseline read
//   2. a span that appears mid-session prints a `+ observed` line and, after
//      the divergence re-read, a `⚠ divergence` line
//   3. re-driving the same span prints nothing new (the seen-set holds)

async function setupSandbox(name: string): Promise<{ cleanup: () => Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-monitor-e2e-'))
  const saved = new Map<string, string | undefined>()
  for (const key of ['NEAT_HOME', 'PORT', 'OTEL_PORT', 'HOST', 'NEAT_AUTH_TOKEN', 'NEAT_API_URL', 'NEAT_CORE_URL']) {
    saved.set(key, process.env[key])
  }
  process.env.NEAT_HOME = home
  process.env.PORT = '0'
  process.env.OTEL_PORT = '0'
  process.env.HOST = '127.0.0.1'
  delete process.env.NEAT_AUTH_TOKEN
  delete process.env.NEAT_API_URL
  delete process.env.NEAT_CORE_URL

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `neat-monitor-proj-${name}-`))
  const real = await fs.realpath(dir)
  await fs.writeFile(path.join(real, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  const { addProject } = await import('../src/registry.js')
  await addProject({ name, path: real, languages: ['javascript'] })

  return {
    cleanup: async () => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      await fs.rm(home, { recursive: true, force: true }).catch(() => {})
    },
  }
}

// A CLIENT span against an unresolvable peer host — mints a FrontierNode plus an
// OBSERVED CALLS edge (ADR-068), i.e. a missing-extracted divergence.
function clientSpanBody(service: string, host: string, spanId: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

describe('neat monitor e2e (ADR-159)', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => {})
  })

  it(
    'streams a divergence line once from a real daemon and stays silent on a repeat',
    { timeout: 30_000 },
    async () => {
      const sandbox = await setupSandbox('mon-e2e')
      cleanups.push(sandbox.cleanup)

      const { startDaemon } = await import('../src/daemon.js')
      const handle = await startDaemon()
      cleanups.push(handle.stop)
      await handle.initialBootstrap
      expect(handle.restAddress).not.toBe('')
      expect(handle.otlpAddress).not.toBe('')

      const ingest = (host: string, spanId: string): Promise<Response> =>
        fetch(`${handle.otlpAddress}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: clientSpanBody('mon-e2e', host, spanId),
        })

      // 1. A divergence exists BEFORE the monitor connects (host A). Wait for
      //    the daemon to actually compute it off its live REST surface.
      expect((await ingest('frontier-alpha.example.test', '1111111111111111')).status).toBe(200)
      const divUrl = `${handle.restAddress}/projects/mon-e2e/graph/divergences`
      const divergenceReady = await pollDivergence(divUrl, 'frontier-alpha', 10_000)
      expect(divergenceReady, 'daemon computed host A divergence').toBe(true)

      // 2. Start the monitor against the live daemon, capturing its stdout.
      const lines: string[] = []
      const controller = new AbortController()
      const monitorDone = runMonitor({
        baseUrl: handle.restAddress,
        project: 'mon-e2e',
        json: false,
        write: (l) => lines.push(l),
        signal: controller.signal,
        debounceMs: 150,
      }).then((code) => {
        expect(code).toBe(0)
      })

      // 3. Baseline read prints host A's divergence, exactly once.
      const sawBaseline = await waitFor(
        () => lines.some((l) => l.includes('⚠ divergence') && l.includes('frontier-alpha')),
        10_000,
      )
      expect(sawBaseline, `baseline divergence for host A. lines=${JSON.stringify(lines)}`).toBe(true)
      expect(lines.filter((l) => l.includes('frontier-alpha')).length).toBe(1)

      // 4. A NEW span mid-session (host B) → `+ observed` + a fresh divergence.
      expect((await ingest('frontier-bravo.example.test', '2222222222222222')).status).toBe(200)
      const sawObservedB = await waitFor(
        () => lines.some((l) => l.startsWith('+ observed') && l.includes('frontier-bravo')),
        10_000,
      )
      expect(sawObservedB, `observed edge for host B. lines=${JSON.stringify(lines)}`).toBe(true)
      const sawDivB = await waitFor(
        () => lines.some((l) => l.includes('⚠ divergence') && l.includes('frontier-bravo')),
        10_000,
      )
      expect(sawDivB, `divergence for host B. lines=${JSON.stringify(lines)}`).toBe(true)

      // 5. Re-drive host B — no new lines (the seen-set holds).
      const beforeRepeat = lines.length
      await ingest('frontier-bravo.example.test', '2222222222222222')
      await new Promise((r) => setTimeout(r, 800))
      expect(lines.length).toBe(beforeRepeat)

      // Expose the captured stdout so the run report can quote the real lines.
      console.log('MONITOR_E2E_OUTPUT>>>\n' + lines.join('') + '<<<MONITOR_E2E_OUTPUT')

      controller.abort()
      await monitorDone

      // Two divergences, one per host, once each.
      expect(lines.filter((l) => l.includes('⚠ divergence')).length).toBe(2)
    },
  )
})

// Poll the live divergence endpoint until it names the host, or time out.
async function pollDivergence(url: string, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const body = (await res.json()) as { divergences?: Array<{ target?: string }> }
        if ((body.divergences ?? []).some((d) => (d.target ?? '').includes(host))) return true
      }
    } catch {
      // daemon still warming — retry
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
