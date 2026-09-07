import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBaseUrl, resolveBaseUrlWithSource } from '../src/base-url.js'

// #488 — the MCP server read only NEAT_CORE_URL, but `neat skill --apply` wrote
// NEAT_API_URL into the generated config. On the default port it worked by
// accident (fallback to localhost:8080); it broke silently the moment the
// daemon wasn't at that default — the hosted-customer case. The server now
// honors both names.

// Every test runs with NEAT_HOME pointed at a fresh empty dir so no real
// ~/.neat/profiles.json can leak into resolution through the active-profile
// level added for hosted login (client-profiles.md §3).
let neatHome: string
let prevNeatHome: string | undefined
beforeEach(() => {
  neatHome = mkdtempSync(join(tmpdir(), 'neat-mcp-home-'))
  prevNeatHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = neatHome
})
afterEach(() => {
  if (prevNeatHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevNeatHome
  rmSync(neatHome, { recursive: true, force: true })
})

function writeProfiles(config: unknown): void {
  writeFileSync(join(neatHome, 'profiles.json'), JSON.stringify(config), 'utf8')
}

describe('resolveBaseUrl env overrides', () => {
  it('reads NEAT_API_URL when NEAT_CORE_URL is unset (the skill-generated case)', () => {
    expect(resolveBaseUrl({ NEAT_API_URL: 'http://daemon.internal:9000' })).toBe(
      'http://daemon.internal:9000',
    )
  })

  it('NEAT_CORE_URL wins when both are set', () => {
    expect(
      resolveBaseUrl({
        NEAT_CORE_URL: 'http://core.internal:9000',
        NEAT_API_URL: 'http://api.internal:9001',
      }),
    ).toBe('http://core.internal:9000')
  })

  it('falls back to localhost:8080 when neither an env nor a daemon record is present', () => {
    // Point the cwd at an empty temp dir so the walk-up finds no daemon.json.
    const dir = mkdtempSync(join(tmpdir(), 'neat-mcp-baseurl-empty-'))
    try {
      expect(resolveBaseUrl({}, dir)).toBe('http://localhost:8080')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ADR-096 / docs/contracts/project-daemon.md — one daemon per project, each
// recording its allocated ports in `<projectRoot>/neat-out/daemon.json`. The
// MCP server resolves the daemon for the project it was launched in by walking
// up from the cwd to the nearest such record and using its REST port. All
// fixtures live in an isolated temp dir; nothing here touches a real daemon,
// real ports, or `~/.neat`.

describe('resolveBaseUrl daemon.json resolution', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'neat-mcp-baseurl-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeDaemonJson(projectRoot: string, record: unknown): void {
    const dir = join(projectRoot, 'neat-out')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify(record), 'utf8')
  }

  const running = (rest: number): Record<string, unknown> => ({
    project: 'alpha',
    projectPath: root,
    pid: 4242,
    status: 'running',
    ports: { rest, otlp: 4318, web: 6328 },
    startedAt: '2026-06-13T00:00:00.000Z',
    neatVersion: '0.4.17',
  })

  it('resolves the daemon REST port from neat-out/daemon.json at the cwd', () => {
    writeDaemonJson(root, running(8123))
    expect(resolveBaseUrl({}, root)).toBe('http://localhost:8123')
  })

  it('walks up parent directories to the nearest daemon.json', () => {
    writeDaemonJson(root, running(8200))
    const nested = join(root, 'packages', 'svc', 'src')
    mkdirSync(nested, { recursive: true })
    expect(resolveBaseUrl({}, nested)).toBe('http://localhost:8200')
  })

  it('lets an explicit NEAT_CORE_URL override beat the daemon record', () => {
    writeDaemonJson(root, running(8123))
    expect(resolveBaseUrl({ NEAT_CORE_URL: 'http://core.internal:9000' }, root)).toBe(
      'http://core.internal:9000',
    )
  })

  it('lets the NEAT_API_URL alias beat the daemon record', () => {
    writeDaemonJson(root, running(8123))
    expect(resolveBaseUrl({ NEAT_API_URL: 'http://daemon.internal:9000' }, root)).toBe(
      'http://daemon.internal:9000',
    )
  })

  it('falls back to localhost:8080 when the daemon has marked itself stopped', () => {
    writeDaemonJson(root, { ...running(8123), status: 'stopped' })
    expect(resolveBaseUrl({}, root)).toBe('http://localhost:8080')
  })

  it('falls back to localhost:8080 on a malformed (garbage) daemon.json', () => {
    const dir = join(root, 'neat-out')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'daemon.json'), '{ this is not json', 'utf8')
    expect(resolveBaseUrl({}, root)).toBe('http://localhost:8080')
  })

  it('falls back to localhost:8080 when the REST port is missing', () => {
    writeDaemonJson(root, {
      project: 'alpha',
      status: 'running',
      ports: { otlp: 4318, web: 6328 },
    })
    expect(resolveBaseUrl({}, root)).toBe('http://localhost:8080')
  })

  it('falls back to localhost:8080 when the REST port is out of range', () => {
    writeDaemonJson(root, running(70000))
    expect(resolveBaseUrl({}, root)).toBe('http://localhost:8080')
  })
})

// #1069 — the startup endpoint check needs to know *how* the URL resolved so it
// can word a foreign-endpoint error precisely (the :8080 fallback reads very
// differently from a misconfigured NEAT_CORE_URL). resolveBaseUrlWithSource
// reports the winning precedence level alongside the URL; the plain
// resolveBaseUrl above is unchanged and just returns its `.url`.

describe('resolveBaseUrlWithSource reports the resolution source', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'neat-mcp-baseurl-src-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('source "env" when NEAT_CORE_URL is set', () => {
    expect(resolveBaseUrlWithSource({ NEAT_CORE_URL: 'http://core.internal:9000' }, root)).toEqual({
      url: 'http://core.internal:9000',
      source: 'env',
    })
  })

  it('source "env" for the NEAT_API_URL alias', () => {
    expect(resolveBaseUrlWithSource({ NEAT_API_URL: 'http://api.internal:9000' }, root)).toEqual({
      url: 'http://api.internal:9000',
      source: 'env',
    })
  })

  it('source "daemon-record" when a daemon.json resolves', () => {
    const dir = join(root, 'neat-out')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'daemon.json'),
      JSON.stringify({ status: 'running', ports: { rest: 8123 } }),
      'utf8',
    )
    expect(resolveBaseUrlWithSource({}, root)).toEqual({
      url: 'http://localhost:8123',
      source: 'daemon-record',
    })
  })

  it('source "default" when neither an env nor a daemon record is present', () => {
    expect(resolveBaseUrlWithSource({}, root)).toEqual({
      url: 'http://localhost:8080',
      source: 'default',
    })
  })
})

// The MCP server follows the same client profile the CLI does, so pointing the
// active profile at a hosted NEAT hooks the agent's tools to the cloud without
// re-registering the server (client-profiles.md §3/§6).
describe('resolveBaseUrlWithSource — profile resolution', () => {
  it('an active profile beats a local daemon record, and carries its token', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neat-mcp-cwd-'))
    try {
      mkdirSync(join(cwd, 'neat-out'), { recursive: true })
      writeFileSync(
        join(cwd, 'neat-out', 'daemon.json'),
        JSON.stringify({ status: 'running', ports: { rest: 8123 } }),
        'utf8',
      )
      writeProfiles({
        version: 1,
        active: 'hosted',
        profiles: [{ name: 'hosted', endpoint: 'https://neat-acme.run.app', authToken: 'dtok' }],
      })
      expect(resolveBaseUrlWithSource({}, cwd)).toEqual({
        url: 'https://neat-acme.run.app',
        source: 'active',
        authToken: 'dtok',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('NEAT_PROFILE selects a named profile above an env pin', () => {
    writeProfiles({
      version: 1,
      active: 'hosted',
      profiles: [
        { name: 'hosted', endpoint: 'https://h.run.app', authToken: 'a' },
        { name: 'staging', endpoint: 'https://s.run.app', authToken: 'b' },
      ],
    })
    expect(
      resolveBaseUrlWithSource({ NEAT_PROFILE: 'staging', NEAT_CORE_URL: 'http://pin:9000' }, '/tmp'),
    ).toEqual({ url: 'https://s.run.app', source: 'profile', authToken: 'b' })
  })

  it('an env pin overrides a stored active profile', () => {
    writeProfiles({
      version: 1,
      active: 'hosted',
      profiles: [{ name: 'hosted', endpoint: 'https://h.run.app', authToken: 'a' }],
    })
    expect(
      resolveBaseUrlWithSource({ NEAT_CORE_URL: 'http://pin:9000', NEAT_AUTH_TOKEN: 'envtok' }, '/tmp'),
    ).toEqual({ url: 'http://pin:9000', source: 'env', authToken: 'envtok' })
  })

  it('a NEAT_PROFILE that names no profile falls through rather than failing', () => {
    writeProfiles({ version: 1, profiles: [{ name: 'hosted', endpoint: 'https://h.run.app' }] })
    const cwd = mkdtempSync(join(tmpdir(), 'neat-mcp-cwd-'))
    try {
      expect(resolveBaseUrlWithSource({ NEAT_PROFILE: 'ghost' }, cwd)).toEqual({
        url: 'http://localhost:8080',
        source: 'default',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('a profile without a token carries no bearer', () => {
    writeProfiles({
      version: 1,
      active: 'local',
      profiles: [{ name: 'local', endpoint: 'http://localhost:9999' }],
    })
    expect(resolveBaseUrlWithSource({}, '/tmp')).toEqual({
      url: 'http://localhost:9999',
      source: 'active',
    })
  })
})
