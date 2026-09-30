import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  daemonProgressLine,
  waitForDaemonReadyForTest,
  type DaemonProgress,
} from '../src/orchestrator.js'

// #1273 — while a project's daemon came up, the bare run printed
// `neat: waiting on 1 project: <name>`, which reads like a queue or a lock. It
// is the daemon starting, so that is what gets said — in words `neat up`
// shares, since both go through the same wait.

describe('daemonProgressLine', () => {
  it('says the daemon is starting', () => {
    expect(daemonProgressLine('EdgeCase', { kind: 'starting' })).toBe(
      'starting the daemon for EdgeCase…',
    )
  })

  it('says how long it has been when it is slow', () => {
    expect(daemonProgressLine('EdgeCase', { kind: 'waiting', elapsedMs: 12_400 })).toBe(
      "still waiting for EdgeCase's daemon (12s)",
    )
  })
})

describe('waiting for a daemon', () => {
  const servers: http.Server[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
    servers.length = 0
  })

  // A daemon that reports its project as bootstrapping until `readyAfterMs`.
  async function daemon(project: string, readyAfterMs: number): Promise<number> {
    const bornAt = Date.now()
    const server = http.createServer((_req, res) => {
      const status = Date.now() - bornAt >= readyAfterMs ? 'active' : 'bootstrapping'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, project, projects: [{ name: project, status }] }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as AddressInfo).port
  }

  it('reminds while the daemon is still coming up, and prints nothing itself', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const events: DaemonProgress[] = []
    const port = await daemon('slow', 1_400)
    const result = await waitForDaemonReadyForTest(port, 'slow', 5_000, (e) => events.push(e), 400)
    expect(result.ready).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events.every((e) => e.kind === 'waiting')).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  it('says nothing about a daemon that is ready straight away', async () => {
    const events: DaemonProgress[] = []
    const port = await daemon('quick', 0)
    const result = await waitForDaemonReadyForTest(port, 'quick', 5_000, (e) => events.push(e), 400)
    expect(result.ready).toBe(true)
    expect(events).toEqual([])
  })
})
