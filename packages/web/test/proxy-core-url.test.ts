import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ADR-101 — the proxy no longer reads a single NEAT_CORE_URL / NEAT_API_URL
// base. One GUI drives many daemons: the API base IS the selected profile's
// endpoint, resolved from daemon discovery (~/.neat/daemons/*.json). These
// tests cover the discovery + endpoint resolution that replaces #418's env
// lookup.

let home: string

function writeDaemon(project: string, rest: number, status: 'running' | 'stopped' = 'running'): void {
  writeFileSync(
    join(home, 'daemons', `${project}.json`),
    JSON.stringify({
      project,
      projectPath: `/tmp/${project}`,
      pid: 1,
      status,
      ports: { rest, otlp: 4318, web: 6328 },
      startedAt: new Date().toISOString(),
      neatVersion: '0.0.0',
    }),
  )
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neat-proxy-'))
  mkdirSync(join(home, 'daemons'), { recursive: true })
  process.env.NEAT_HOME = home
})

afterEach(() => {
  delete process.env.NEAT_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('ADR-101 — per-daemon discovery replaces the single core URL', () => {
  it('discoverProfiles enumerates ~/.neat/daemons/*.json into profiles', async () => {
    writeDaemon('alpha', 8080)
    writeDaemon('beta', 9090, 'stopped')
    const { discoverProfiles } = await import('../lib/proxy')
    const profiles = await discoverProfiles()
    expect(profiles).toEqual([
      { project: 'alpha', endpoint: 'http://127.0.0.1:8080', status: 'running' },
      { project: 'beta', endpoint: 'http://127.0.0.1:9090', status: 'stopped' },
    ])
  })

  it('endpointForProject resolves a label to its daemon REST endpoint', async () => {
    writeDaemon('alpha', 8080)
    const { endpointForProject } = await import('../lib/proxy')
    expect(await endpointForProject('alpha')).toBe('http://127.0.0.1:8080')
  })

  it('endpointForProject returns null for an unknown label (empty state, not a default)', async () => {
    writeDaemon('alpha', 8080)
    const { endpointForProject } = await import('../lib/proxy')
    expect(await endpointForProject('nope')).toBe(null)
    expect(await endpointForProject(null)).toBe(null)
  })

  it('discoverProfiles returns [] when no discovery directory exists (legacy daemon → empty state)', async () => {
    rmSync(join(home, 'daemons'), { recursive: true, force: true })
    const { discoverProfiles } = await import('../lib/proxy')
    expect(await discoverProfiles()).toEqual([])
  })

  it('skips malformed records rather than failing the whole enumeration', async () => {
    writeDaemon('good', 8080)
    writeFileSync(join(home, 'daemons', 'broken.json'), '{ not json')
    const { discoverProfiles } = await import('../lib/proxy')
    const profiles = await discoverProfiles()
    expect(profiles.map((p) => p.project)).toEqual(['good'])
  })
})

describe('firstReachableEndpoint — the no-project default prefers a running daemon (#559)', () => {
  it('skips a stopped first profile for a running one later in the list', async () => {
    // 'alpha' sorts first but is stopped; 'beta' is running. The auth
    // negotiation must land on beta, not the dead alpha (web-multi-project §2.3).
    writeDaemon('alpha', 8080, 'stopped')
    writeDaemon('beta', 9090, 'running')
    const { discoverProfiles, firstReachableEndpoint } = await import('../lib/proxy')
    const profiles = await discoverProfiles()
    expect(firstReachableEndpoint(profiles)).toBe('http://127.0.0.1:9090')
  })

  it('falls back to profiles[0] when none are running (single stopped dev box)', async () => {
    writeDaemon('alpha', 8080, 'stopped')
    writeDaemon('beta', 9090, 'stopped')
    const { discoverProfiles, firstReachableEndpoint } = await import('../lib/proxy')
    const profiles = await discoverProfiles()
    // Preserve today's last-resort behavior: alpha sorts first, so it wins.
    expect(firstReachableEndpoint(profiles)).toBe('http://127.0.0.1:8080')
  })

  it('returns undefined for an empty discovery set', async () => {
    const { firstReachableEndpoint } = await import('../lib/proxy')
    expect(firstReachableEndpoint([])).toBeUndefined()
  })
})
