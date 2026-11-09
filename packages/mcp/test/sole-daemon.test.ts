import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBaseUrlWithSource } from '../src/base-url.js'
import { createHttpClient, localDaemonHint } from '../src/client.js'

// #1401 / ADR-259 — the overnight bench arm's MCP server was started by the agent
// harness from a directory that is no registered project, with no NEAT_CORE_URL.
// It fell to http://localhost:8080 while the one daemon there was ran on :8098,
// so every tool call failed with "Cannot reach the NEAT daemon". The CLI already
// resolves to the sole running daemon in that case (#1381); the MCP server now
// does too, and a miss names the running daemons and the fix.

let neatHome: string
let cwd: string
let prevNeatHome: string | undefined
const servers: Server[] = []

beforeEach(() => {
  neatHome = mkdtempSync(join(tmpdir(), 'neat-mcp-sole-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'neat-mcp-sole-cwd-'))
  prevNeatHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = neatHome
  mkdirSync(join(neatHome, 'daemons'))
})
afterEach(async () => {
  if (prevNeatHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevNeatHome
  rmSync(neatHome, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

// A stand-in daemon: answers /health and one graph read.
async function startDaemon(): Promise<number> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') res.end(JSON.stringify({ status: 'ok', project: 'hotel' }))
    else if (req.url?.startsWith('/graph/divergences')) res.end(JSON.stringify({ divergences: [] }))
    else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

function writeRecord(project: string, rest: number, pid = process.pid): void {
  writeFileSync(
    join(neatHome, 'daemons', `${project}.json`),
    JSON.stringify({
      project,
      projectPath: `/srv/${project}`,
      pid,
      status: 'running',
      ports: { rest, otlp: rest + 1, web: rest + 2 },
      startedAt: '2026-10-17T00:00:00.000Z',
      neatVersion: '0.10.7',
    }),
  )
}

describe('MCP server with no env, from a directory that is no project (ADR-259)', () => {
  it('resolves to the one running daemon and reaches it', async () => {
    const port = await startDaemon()
    writeRecord('hotel', port)
    const resolved = resolveBaseUrlWithSource({ NEAT_HOME: neatHome }, cwd)
    expect(resolved).toEqual({ url: `http://localhost:${port}`, source: 'sole-daemon' })
    const client = createHttpClient(resolved.url.replace('localhost', '127.0.0.1'))
    await expect(client.get('/graph/divergences')).resolves.toEqual({ divergences: [] })
  })

  it('carries NEAT_AUTH_TOKEN to the sole daemon', () => {
    writeRecord('hotel', 18098)
    expect(resolveBaseUrlWithSource({ NEAT_HOME: neatHome, NEAT_AUTH_TOKEN: 't0k' }, cwd)).toEqual({
      url: 'http://localhost:18098',
      source: 'sole-daemon',
      authToken: 't0k',
    })
  })

  it('a stopped or dead daemon does not count', () => {
    writeRecord('gone', 18098, 999_999_999)
    expect(resolveBaseUrlWithSource({ NEAT_HOME: neatHome }, cwd).source).toBe('default')
  })

  it('two running daemons fall to loopback, and the miss names both and the fix', async () => {
    writeRecord('hotel', 18098)
    writeRecord('social', 18099)
    expect(resolveBaseUrlWithSource({ NEAT_HOME: neatHome }, cwd).source).toBe('default')
    const hint = localDaemonHint('http://localhost:8080')
    expect(hint).toContain('hotel → http://localhost:18098')
    expect(hint).toContain('social → http://localhost:18099')
    expect(hint).toContain('npx neat.is claude install')
    expect(hint).toContain('NEAT_CORE_URL=http://localhost:18098')
  })

  it('the unreachable error a tool returns carries that fix', async () => {
    writeRecord('hotel', 18098)
    writeRecord('social', 18099)
    const client = createHttpClient('http://localhost:1')
    await expect(client.get('/graph/divergences')).rejects.toThrow(
      /Cannot reach the NEAT daemon on GET \/graph\/divergences: .*Running: hotel → http:\/\/localhost:18098/,
    )
  })

  it('with no daemon running, it says to start one', () => {
    expect(localDaemonHint('http://localhost:8080')).toMatch(/No NEAT daemon is running/)
  })

  it('an env pin still wins over the sole daemon', () => {
    writeRecord('hotel', 18098)
    expect(resolveBaseUrlWithSource({ NEAT_HOME: neatHome, NEAT_CORE_URL: 'http://pinned:1' }, cwd).source).toBe('env')
  })
})
