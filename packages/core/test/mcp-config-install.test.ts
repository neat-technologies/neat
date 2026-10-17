import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSkill } from '../src/cli.js'
import { runClaudeCommand } from '../src/claude-cli.js'
import { writeClaudeMcpEntry } from '../src/cli.js'

// #1401 / #1397 / ADR-259 — the installers wrote mcpServers.neat with a fixed
// NEAT_CORE_URL=http://localhost:8080 (`neat skill --apply`) or none at all
// (`neat claude install`), so a daemon on any other port was unreachable from
// the agent. They now write the address the CLI resolves for this directory,
// and the bearer when this shell carries one.

let home: string
let cwd: string
let claudeJson: string
const saved: Record<string, string | undefined> = {}
const KEYS = ['NEAT_HOME', 'NEAT_CLAUDE_CONFIG', 'NEAT_AUTH_TOKEN', 'NEAT_CORE_URL', 'NEAT_API_URL', 'NEAT_PROFILE', 'NEAT_CLAUDE_MD']

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
  home = mkdtempSync(join(tmpdir(), 'neat-mcp-install-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'neat-mcp-install-cwd-'))
  claudeJson = join(home, '.claude.json')
  process.env.NEAT_HOME = home
  process.env.NEAT_CLAUDE_CONFIG = claudeJson
  mkdirSync(join(home, 'daemons'))
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function liveDaemon(project: string, rest: number): void {
  writeFileSync(
    join(home, 'daemons', `${project}.json`),
    JSON.stringify({
      project,
      projectPath: `/srv/${project}`,
      pid: process.pid,
      status: 'running',
      ports: { rest, otlp: rest + 1, web: rest + 2 },
      startedAt: '2026-10-17T00:00:00.000Z',
      neatVersion: '0.10.7',
    }),
  )
}

function neatEntry(): { env?: Record<string, string>; args: string[] } {
  return JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.neat
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
  }
}

describe('installers aim the MCP server at the resolved daemon (ADR-259)', () => {
  it('skill --apply writes the running daemon and the token from this shell', async () => {
    liveDaemon('hotel', 8098)
    process.env.NEAT_AUTH_TOKEN = 'sekret'
    const prevCwd = process.cwd()
    process.chdir(cwd)
    try {
      expect((await quiet(() => runSkill({ apply: true, printConfig: false }))).exitCode).toBe(0)
    } finally {
      process.chdir(prevCwd)
    }
    expect(neatEntry().env).toEqual({ NEAT_CORE_URL: 'http://localhost:8098', NEAT_AUTH_TOKEN: 'sekret' })
  })

  it('writes no env when no daemon resolves, so the server resolves at start', async () => {
    const { env } = await writeClaudeMcpEntry(cwd)
    expect(env).toEqual({})
    expect(neatEntry().env).toBeUndefined()
    expect(neatEntry().args).toContain('@neat.is/mcp')
  })

  it('an env pin is what gets written', async () => {
    process.env.NEAT_CORE_URL = 'http://core.internal:9000'
    await writeClaudeMcpEntry(cwd)
    expect(neatEntry().env).toEqual({ NEAT_CORE_URL: 'http://core.internal:9000' })
  })

  it('claude install writes the directive and wires the MCP server', async () => {
    liveDaemon('hotel', 8098)
    process.env.NEAT_CLAUDE_MD = join(cwd, 'CLAUDE.md')
    let wired = ''
    const code = await quiet(() =>
      runClaudeCommand(['install'], async () => {
        const { target, env } = await writeClaudeMcpEntry(cwd)
        wired = `${target} ${env.NEAT_CORE_URL}`
        return wired
      }),
    )
    expect(code).toBe(0)
    expect(wired).toBe(`${claudeJson} http://localhost:8098`)
    expect(neatEntry().env).toEqual({ NEAT_CORE_URL: 'http://localhost:8098' })
  })
})
