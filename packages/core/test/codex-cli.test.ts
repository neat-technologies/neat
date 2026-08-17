import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import {
  runCodex,
  runCodexCommand,
  CODEX_MCP_SERVER,
  CODEX_NEAT_BLOCK,
  NEAT_GRAPH_FIRST_START,
  NEAT_GRAPH_FIRST_END,
  upsertCodexConfig,
} from '../src/codex-cli.js'

// `neat codex` (ADR-163): install NEAT into the OpenAI Codex CLI — an
// [mcp_servers.neat] table in ~/.codex/config.toml plus the graph-first block
// in AGENTS.md. Everything runs against a temp config + a temp AGENTS.md via
// NEAT_CODEX_CONFIG / NEAT_CODEX_AGENTS, never the real ones. The shared
// invariants: merge never clobbers, a re-run is a no-op, plan mode writes
// nothing, and a malformed config is a clean error with no partial write.

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-codex-cli-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return real
}

// Run runCodex against a temp config + AGENTS.md, capturing stdout/stderr.
async function withTmpEnv<T>(
  fn: (env: {
    config: string
    agents: string
    out: () => string
    err: () => string
  }) => Promise<T>,
): Promise<T> {
  const root = await makeTmp()
  const config = path.join(root, 'codex', 'config.toml')
  const agents = path.join(root, 'project', 'AGENTS.md')
  const outLines: string[] = []
  const errLines: string[] = []
  const prevConfig = process.env.NEAT_CODEX_CONFIG
  const prevAgents = process.env.NEAT_CODEX_AGENTS
  const prevLog = console.log
  const prevErr = console.error
  const prevWrite = process.stdout.write.bind(process.stdout)
  process.env.NEAT_CODEX_CONFIG = config
  process.env.NEAT_CODEX_AGENTS = agents
  console.log = (...args: unknown[]) => {
    outLines.push(args.join(' '))
  }
  console.error = (...args: unknown[]) => {
    errLines.push(args.join(' '))
  }
  ;(process.stdout.write as unknown) = (chunk: string) => {
    outLines.push(String(chunk))
    return true
  }
  try {
    return await fn({
      config,
      agents,
      out: () => outLines.join('\n'),
      err: () => errLines.join('\n'),
    })
  } finally {
    console.log = prevLog
    console.error = prevErr
    ;(process.stdout.write as unknown) = prevWrite
    if (prevConfig === undefined) delete process.env.NEAT_CODEX_CONFIG
    else process.env.NEAT_CODEX_CONFIG = prevConfig
    if (prevAgents === undefined) delete process.env.NEAT_CODEX_AGENTS
    else process.env.NEAT_CODEX_AGENTS = prevAgents
  }
}

async function readOr(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

describe('neat codex — the shipped block', () => {
  it('the rendered TOML block parses to exactly the neat MCP server', () => {
    const parsed = parseToml(CODEX_NEAT_BLOCK) as {
      mcp_servers: { neat: unknown }
    }
    expect(parsed.mcp_servers.neat).toEqual(CODEX_MCP_SERVER)
  })

  it('wires @neat.is/mcp over npx with NEAT_CORE_URL', () => {
    expect(CODEX_MCP_SERVER.command).toBe('npx')
    expect(CODEX_MCP_SERVER.args).toContain('@neat.is/mcp')
    expect(CODEX_MCP_SERVER.env.NEAT_CORE_URL).toMatch(/^https?:\/\//)
  })
})

describe('neat codex --apply', () => {
  it('writes a valid config.toml with the neat server + AGENTS.md with the guidance', async () => {
    await withTmpEnv(async ({ config, agents }) => {
      const { exitCode } = await runCodex({
        apply: true,
        printConfig: false,
        printGuide: false,
      })
      expect(exitCode).toBe(0)

      const toml = await fs.readFile(config, 'utf8')
      const parsed = parseToml(toml) as { mcp_servers: { neat: unknown } }
      expect(parsed.mcp_servers.neat).toEqual(CODEX_MCP_SERVER)

      const agentsRaw = await fs.readFile(agents, 'utf8')
      expect(agentsRaw).toContain(NEAT_GRAPH_FIRST_START)
      expect(agentsRaw).toContain(NEAT_GRAPH_FIRST_END)
      // The reused GRAPH_FIRST.md guidance landed inside the block — the
      // imperative query-first directive (ADR-196) leads with `neat ask`.
      expect(agentsRaw).toMatch(/Query the graph FIRST/)
      expect(agentsRaw).toMatch(/neat ask/)
      expect(agentsRaw).toMatch(/semantic_search/)
    })
  })

  it('is idempotent — a re-run writes identical bytes and one neat table', async () => {
    await withTmpEnv(async ({ config, agents }) => {
      await runCodex({ apply: true, printConfig: false, printGuide: false })
      const config1 = await fs.readFile(config, 'utf8')
      const agents1 = await fs.readFile(agents, 'utf8')

      await runCodex({ apply: true, printConfig: false, printGuide: false })
      const config2 = await fs.readFile(config, 'utf8')
      const agents2 = await fs.readFile(agents, 'utf8')

      expect(config2).toBe(config1)
      expect(agents2).toBe(agents1)
      // Exactly one neat table and one marker block.
      expect(config2.match(/\[mcp_servers\.neat\]/g)?.length).toBe(1)
      expect(agents2.match(new RegExp(NEAT_GRAPH_FIRST_START, 'g'))?.length).toBe(1)
    })
  })

  it('preserves an existing mcp server and other config in config.toml', async () => {
    await withTmpEnv(async ({ config }) => {
      await fs.mkdir(path.dirname(config), { recursive: true })
      const existing = [
        '# my Codex config',
        'model = "gpt-5-codex"',
        '',
        '[mcp_servers.filesystem]',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]',
        '',
      ].join('\n')
      await fs.writeFile(config, existing, 'utf8')

      await runCodex({ apply: true, printConfig: false, printGuide: false })

      const toml = await fs.readFile(config, 'utf8')
      const parsed = parseToml(toml) as {
        model: string
        mcp_servers: { neat: unknown; filesystem: { command: string; args: string[] } }
      }
      // Our server landed…
      expect(parsed.mcp_servers.neat).toEqual(CODEX_MCP_SERVER)
      // …and the user's server + top-level key survived intact.
      expect(parsed.model).toBe('gpt-5-codex')
      expect(parsed.mcp_servers.filesystem.command).toBe('npx')
      expect(parsed.mcp_servers.filesystem.args).toContain(
        '@modelcontextprotocol/server-filesystem',
      )
      // The byte-preserving splice kept the user's comment.
      expect(toml).toContain('# my Codex config')
    })
  })

  it("appends to AGENTS.md below the user's own content, preserving it", async () => {
    await withTmpEnv(async ({ agents }) => {
      await fs.mkdir(path.dirname(agents), { recursive: true })
      const mine = '# My project\n\nAlways run the tests before committing.\n'
      await fs.writeFile(agents, mine, 'utf8')

      await runCodex({ apply: true, printConfig: false, printGuide: false })

      const raw = await fs.readFile(agents, 'utf8')
      expect(raw).toContain('Always run the tests before committing.')
      expect(raw).toContain(NEAT_GRAPH_FIRST_START)
      // The user's content comes first, NEAT's block after.
      expect(raw.indexOf('Always run the tests')).toBeLessThan(
        raw.indexOf(NEAT_GRAPH_FIRST_START),
      )
    })
  })
})

describe('neat codex — plan mode (default)', () => {
  it('prints the plan and writes nothing', async () => {
    await withTmpEnv(async ({ config, agents, out }) => {
      const { exitCode } = await runCodex({
        apply: false,
        printConfig: false,
        printGuide: false,
      })
      expect(exitCode).toBe(0)
      expect(await readOr(config)).toBeNull()
      expect(await readOr(agents)).toBeNull()
      expect(out()).toContain('[mcp_servers.neat]')
      expect(out()).toMatch(/nothing written/i)
    })
  })
})

describe('neat codex — malformed config', () => {
  it('exits 1 with a clear error and writes nothing', async () => {
    await withTmpEnv(async ({ config, agents, err }) => {
      await fs.mkdir(path.dirname(config), { recursive: true })
      // A broken TOML table header — no closing bracket.
      const before = '[mcp_servers.other\ncommand = "x"\n'
      await fs.writeFile(config, before, 'utf8')

      const { exitCode } = await runCodex({
        apply: true,
        printConfig: false,
        printGuide: false,
      })
      expect(exitCode).toBe(1)
      expect(err()).toMatch(/not valid TOML/i)
      // No partial write: the config is untouched and AGENTS.md was not created.
      expect(await fs.readFile(config, 'utf8')).toBe(before)
      expect(await readOr(agents)).toBeNull()
    })
  })
})

describe('neat codex — print flags & argv', () => {
  it('--print-config emits the TOML block; --print-guide emits the AGENTS.md block', async () => {
    await withTmpEnv(async ({ out }) => {
      await runCodex({ apply: false, printConfig: true, printGuide: false })
      await runCodex({ apply: false, printConfig: false, printGuide: true })
      const body = out()
      expect(body).toContain('[mcp_servers.neat]')
      expect(body).toContain(NEAT_GRAPH_FIRST_START)
    })
  })

  it('rejects an unknown flag with exit code 2', async () => {
    const prevErr = console.error
    const prevLog = console.log
    console.error = () => {}
    console.log = () => {}
    try {
      expect(await runCodexCommand(['--bogus'])).toBe(2)
    } finally {
      console.error = prevErr
      console.log = prevLog
    }
  })
})

describe('upsertCodexConfig — the round-trip fallback', () => {
  it('preserves other tables when the splice cannot prove itself lossless', () => {
    // A neat server declared with top-level dotted keys (no [mcp_servers.neat]
    // header) exercises the fallback: the splice would append a duplicate, so
    // the verified round-trip takes over and still keeps the sibling server.
    const raw = [
      'mcp_servers.neat.command = "old"',
      '',
      '[mcp_servers.other]',
      'command = "keep"',
      '',
    ].join('\n')
    const { text } = upsertCodexConfig(raw)
    const parsed = parseToml(text) as {
      mcp_servers: { neat: unknown; other: { command: string } }
    }
    expect(parsed.mcp_servers.neat).toEqual(CODEX_MCP_SERVER)
    expect(parsed.mcp_servers.other.command).toBe('keep')
  })
})
