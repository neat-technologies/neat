import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBaseUrl } from '../src/base-url.js'

// #488 — the MCP server read only NEAT_CORE_URL, but `neat skill --apply` wrote
// NEAT_API_URL into the generated config. On the default port it worked by
// accident (fallback to localhost:8080); it broke silently the moment the
// daemon wasn't at that default — the hosted-customer case. The server now
// honors both names.

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
