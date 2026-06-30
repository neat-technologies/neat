import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { isPortFree } from '../src/orchestrator.js'
import { resolveHost } from '../src/daemon.js'

// #574 — the port allocator must probe the same interface the daemon binds.
//
// On the authenticated path the daemon binds 0.0.0.0 (resolveHost). The
// allocator used to probe loopback unconditionally, so a port already held on
// the wildcard interface by a sibling daemon read as free, got handed to the
// spawn, and the new daemon then died on EADDRINUSE binding 0.0.0.0 — before
// it could write daemon.json, surfacing only as a silent "daemon.json
// timeout". The fix threads the resolved bind host into the free-port check so
// the interface probed always equals the interface the daemon will bind.

function hold(host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, host, () => resolve(server))
  })
}

function portOf(server: net.Server): number {
  const addr = server.address()
  if (addr && typeof addr === 'object') return addr.port
  throw new Error('expected a bound TCP port')
}

describe('port allocator bind-host probe (#574)', () => {
  const held: net.Server[] = []
  const savedHost = process.env.HOST

  afterEach(async () => {
    await Promise.all(
      held.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    )
    if (savedHost === undefined) delete process.env.HOST
    else process.env.HOST = savedHost
  })

  it('reads a wildcard-held port as taken when probing the token bind host', async () => {
    const server = await hold('0.0.0.0')
    held.push(server)
    const port = portOf(server)
    // The token path binds 0.0.0.0; probing that interface catches the holder
    // so the allocator steps past it instead of handing over a doomed port.
    expect(await isPortFree(port, '0.0.0.0')).toBe(false)
  })

  it('probes loopback by default — the no-token bind host', async () => {
    const server = await hold('127.0.0.1')
    held.push(server)
    const port = portOf(server)
    expect(await isPortFree(port, '127.0.0.1')).toBe(false)
    // No host argument falls back to loopback, matching resolveHost's no-token
    // default, so the same loopback-held port still reads as taken.
    expect(await isPortFree(port)).toBe(false)
  })

  it('takes its probe host from resolveHost, so token state decides the interface', () => {
    delete process.env.HOST
    // resolveHost is the single source of the bind decision the orchestrator
    // feeds into the probe: token → 0.0.0.0, no token → loopback.
    expect(resolveHost({}, true)).toBe('0.0.0.0')
    expect(resolveHost({}, false)).toBe('127.0.0.1')
  })
})
