// `neat codex` — one-command install of NEAT into the OpenAI Codex CLI.
//
// NEAT already ships a one-install Claude Code plugin (ADR-159) and the
// `neat skill`/`neat hooks` à-la-carte commands for Claude Code. Every other
// MCP-capable agent has to be wired by hand. This closes the Codex gap ADR-159
// named ("both Claude Code and Codex"), mirroring the skill/hooks shape:
//
//   1. Add an `[mcp_servers.neat]` table to `~/.codex/config.toml` — the MCP
//      server invocation is `npx -y @neat.is/mcp`, the same one the Claude
//      skill writes. Codex reads MCP servers from that TOML file under
//      `[mcp_servers.<name>]` (command + optional args + optional env for a
//      local stdio server). Any existing servers and all other config are
//      preserved; a re-run only refreshes NEAT's own table.
//
//   2. Write NEAT's agent-agnostic graph-first guidance (GRAPH_FIRST.md, the
//      same block the hooks command materialises) into `AGENTS.md` at the
//      project root, delimited by stable markers so a re-run replaces only
//      NEAT's block and leaves the user's own instructions alone.
//
// Plan by default (print the diff, write nothing); `--apply` to write. A
// malformed existing config.toml is a clear error and no partial write — a
// wrong config is worse than none. This is a config command family (like
// `neat connector` / `neat hooks`), not a locked query verb, so it parses its
// own argv.

import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { GUIDE_FILENAME, readSkillAsset } from './hooks-cli.js'

// The MCP server NEAT registers with Codex. The invocation matches the Claude
// skill (`npx -y @neat.is/mcp`); NEAT_CORE_URL is the canonical env var the MCP
// server reads for the daemon URL, defaulting to the local daemon.
export const CODEX_MCP_SERVER = {
  command: 'npx',
  args: ['-y', '@neat.is/mcp'],
  env: { NEAT_CORE_URL: 'http://localhost:8080' },
} as const

// The canonical `[mcp_servers.neat]` block, rendered deterministically. All
// values are fixed constants with no TOML-special characters, so a template is
// exact; the block is re-parsed and verified before anything is written.
export const CODEX_NEAT_BLOCK = [
  '[mcp_servers.neat]',
  'command = "npx"',
  'args = ["-y", "@neat.is/mcp"]',
  'env = { NEAT_CORE_URL = "http://localhost:8080" }',
].join('\n')

// Stable delimiters around NEAT's graph-first block in AGENTS.md, so a re-run
// replaces only NEAT's block and never the user's own guidance.
export const NEAT_GRAPH_FIRST_START = '<!-- neat:graph-first -->'
export const NEAT_GRAPH_FIRST_END = '<!-- /neat:graph-first -->'

// ~/.codex/config.toml — Codex CLI's user-level config. Overridable via
// NEAT_CODEX_CONFIG so tests never touch the real file.
export function codexConfigPath(): string {
  const override = process.env.NEAT_CODEX_CONFIG
  if (override && override.length > 0) return path.resolve(override)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.codex', 'config.toml')
}

// AGENTS.md at the project root (cwd). Overridable via NEAT_CODEX_AGENTS so
// tests can point it at a temp file without changing the process cwd.
export function agentsFilePath(): string {
  const override = process.env.NEAT_CODEX_AGENTS
  if (override && override.length > 0) return path.resolve(override)
  return path.join(process.cwd(), 'AGENTS.md')
}

// A TOML table/array-of-tables header line, e.g. `[mcp_servers.neat]`.
function isTableHeader(line: string): boolean {
  return /^\s*\[\[?[^\]]+\]\]?\s*$/.test(line)
}

// The dotted name inside a header line, whitespace-trimmed.
function tableName(line: string): string {
  return line.trim().replace(/^\[\[?/, '').replace(/\]\]?$/, '').trim()
}

function isNeatHeader(line: string): boolean {
  return isTableHeader(line) && tableName(line) === 'mcp_servers.neat'
}

// True when a header belongs to NEAT's own table (the table itself or a
// sub-table like `[mcp_servers.neat.env]`), so a re-run consumes and refreshes
// the whole definition rather than leaving a stale sub-table behind.
function isNeatChildHeader(line: string): boolean {
  if (!isTableHeader(line)) return false
  const name = tableName(line)
  return name === 'mcp_servers.neat' || name.startsWith('mcp_servers.neat.')
}

// Splice NEAT's `[mcp_servers.neat]` block into an existing config.toml,
// preserving every other table, key, value, and comment. Returns the new text
// and whether it differs from the input. Throws on malformed TOML (fail
// honest — the caller turns that into a clear error with no write).
//
// The common path is a byte-preserving splice (only the whitespace directly
// around NEAT's own block is normalised); it is then re-parsed and deep-compared
// against the original parse, and any mismatch falls back to a full smol-toml
// round-trip that is guaranteed to preserve every key. Either way an unverified
// config is never returned.
export function upsertCodexConfig(raw: string): { text: string; changed: boolean } {
  const trimmed = raw.trim()
  const parsed = (trimmed.length > 0 ? parseToml(raw) : {}) as Record<string, unknown>

  // Already exactly what we'd write? Report no change without reformatting.
  const existingServers = (parsed.mcp_servers ?? {}) as Record<string, unknown>
  const spliced = spliceNeatBlock(raw)

  let text: string
  if (verifyPreserved(raw, spliced, parsed)) {
    text = spliced
  } else {
    // Fallback: the real serializer. Preserves every key; loses only comments
    // and exact layout. Used only when the splice can't be proven lossless.
    const merged = {
      ...parsed,
      mcp_servers: { ...existingServers, neat: CODEX_MCP_SERVER },
    }
    text = stringifyToml(merged)
    if (!text.endsWith('\n')) text += '\n'
  }

  return { text, changed: text !== raw }
}

// Textual splice of the neat block, boundary-detected by table headers.
function spliceNeatBlock(raw: string): string {
  const block = CODEX_NEAT_BLOCK
  const lines = raw.length > 0 ? raw.split('\n') : []

  const start = lines.findIndex(isNeatHeader)
  if (start === -1) {
    const base = raw.replace(/\n+$/, '')
    return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`
  }

  // Consume NEAT's header, its body, and any of its own sub-tables; stop at the
  // first unrelated table header (or EOF).
  let end = start + 1
  for (;;) {
    while (end < lines.length && !isTableHeader(lines[end])) end++
    if (end < lines.length && isNeatChildHeader(lines[end])) {
      end++
      continue
    }
    break
  }

  const before = lines.slice(0, start).join('\n').replace(/\n*$/, '')
  const after = lines.slice(end).join('\n').replace(/^\n*/, '')

  let text = ''
  if (before.length > 0) text += `${before}\n\n`
  text += `${block}\n`
  if (after.length > 0) text += `\n${after}`
  return `${text.replace(/\n*$/, '')}\n`
}

// Confirm the spliced text parses, carries exactly our neat server, and left
// every other table/key byte-equal to the original parse.
function verifyPreserved(
  raw: string,
  spliced: string,
  original: Record<string, unknown>,
): boolean {
  let next: Record<string, unknown>
  try {
    next = parseToml(spliced) as Record<string, unknown>
  } catch {
    return false
  }

  const origServers = (original.mcp_servers ?? {}) as Record<string, unknown>
  const nextServers = (next.mcp_servers ?? {}) as Record<string, unknown>

  if (!isDeepStrictEqual(nextServers.neat, CODEX_MCP_SERVER)) return false
  for (const name of Object.keys(origServers)) {
    if (name === 'neat') continue
    if (!isDeepStrictEqual(nextServers[name], origServers[name])) return false
  }
  for (const name of Object.keys(nextServers)) {
    if (name !== 'neat' && !(name in origServers)) return false
  }
  for (const key of Object.keys(original)) {
    if (key === 'mcp_servers') continue
    if (!isDeepStrictEqual(next[key], original[key])) return false
  }
  for (const key of Object.keys(next)) {
    if (key !== 'mcp_servers' && !(key in original)) return false
  }
  return true
}

// The AGENTS.md graph-first block: NEAT's guidance wrapped in the stable
// markers.
export function agentsBlock(guide: string): string {
  return `${NEAT_GRAPH_FIRST_START}\n${guide.replace(/\s+$/, '')}\n${NEAT_GRAPH_FIRST_END}\n`
}

// Write (or refresh) NEAT's graph-first block in AGENTS.md, replacing only the
// delimited block and preserving the user's other content byte-for-byte.
export function upsertAgents(raw: string, guide: string): { text: string; changed: boolean } {
  const block = agentsBlock(guide)
  if (raw.length === 0) return { text: block, changed: true }

  const startIdx = raw.indexOf(NEAT_GRAPH_FIRST_START)
  const endIdx = raw.indexOf(NEAT_GRAPH_FIRST_END)
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = raw.slice(0, startIdx)
    const after = raw.slice(endIdx + NEAT_GRAPH_FIRST_END.length)
    const text = `${before}${block.replace(/\n+$/, '')}${after}`
    return { text, changed: text !== raw }
  }

  const base = raw.replace(/\n+$/, '')
  const text = base.length > 0 ? `${base}\n\n${block}` : block
  return { text, changed: text !== raw }
}

export interface CodexOptions {
  apply: boolean
  printConfig: boolean
  printGuide: boolean
}

async function readGuide(): Promise<string> {
  return readSkillAsset(GUIDE_FILENAME)
}

export async function runCodex(opts: CodexOptions): Promise<{ exitCode: number }> {
  if (opts.printConfig) {
    process.stdout.write(`${CODEX_NEAT_BLOCK}\n`)
    return { exitCode: 0 }
  }

  if (opts.printGuide) {
    process.stdout.write(agentsBlock(await readGuide()))
    return { exitCode: 0 }
  }

  const configPath = codexConfigPath()
  const agentsPath = agentsFilePath()

  // Read what's there (absent files are fine — we create them on apply).
  let configRaw = ''
  try {
    configRaw = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`neat codex: failed to read ${configPath} — ${(err as Error).message}`)
      return { exitCode: 1 }
    }
  }

  let agentsRaw = ''
  try {
    agentsRaw = await fs.readFile(agentsPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`neat codex: failed to read ${agentsPath} — ${(err as Error).message}`)
      return { exitCode: 1 }
    }
  }

  // A malformed existing config is a hard stop — no partial write.
  let config: { text: string; changed: boolean }
  try {
    config = upsertCodexConfig(configRaw)
  } catch (err) {
    console.error(
      `neat codex: ${configPath} is not valid TOML — ${(err as Error).message}`,
    )
    console.error('neat codex: fix the file and re-run; nothing was written.')
    return { exitCode: 1 }
  }

  const guide = await readGuide()
  const agents = upsertAgents(agentsRaw, guide)

  if (!opts.apply) {
    // Plan by default: describe the change, write nothing.
    console.log('neat codex — plan (nothing written; re-run with --apply to write)')
    console.log('')
    console.log(`  Codex MCP config: ${configPath}`)
    console.log(
      config.changed
        ? `    ${configRaw ? 'update' : 'create'} the [mcp_servers.neat] table:`
        : '    already up to date — [mcp_servers.neat] matches',
    )
    if (config.changed) {
      for (const line of CODEX_NEAT_BLOCK.split('\n')) console.log(`      ${line}`)
    }
    console.log('')
    console.log(`  Project instructions: ${agentsPath}`)
    console.log(
      agents.changed
        ? `    ${agentsRaw ? 'update' : 'create'} the graph-first block (between ${NEAT_GRAPH_FIRST_START} markers)`
        : '    already up to date — graph-first block matches',
    )
    console.log('')
    console.log('The MCP server reads NEAT_CORE_URL for the daemon URL — edit that value in')
    console.log('the generated table to point Codex at a non-default daemon.')
    return { exitCode: 0 }
  }

  // Apply: write only what actually changed.
  if (config.changed) {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, config.text, 'utf8')
    console.log(`neat codex: wrote [mcp_servers.neat] to ${configPath}`)
  } else {
    console.log(`neat codex: ${configPath} already has NEAT's MCP server`)
  }

  if (agents.changed) {
    await fs.mkdir(path.dirname(agentsPath), { recursive: true })
    await fs.writeFile(agentsPath, agents.text, 'utf8')
    console.log(`neat codex: wrote the graph-first block to ${agentsPath}`)
  } else {
    console.log(`neat codex: ${agentsPath} already has the graph-first block`)
  }

  console.log('')
  console.log('restart Codex to pick up the new MCP server. NEAT_CORE_URL in the table')
  console.log('points the server at the local daemon — edit it for a non-default one.')
  return { exitCode: 0 }
}

function usage(): void {
  console.log('neat codex — install NEAT into the OpenAI Codex CLI (MCP server + AGENTS.md)')
  console.log('')
  console.log('  (no flag)        plan: print what would change, write nothing')
  console.log('  --apply          add [mcp_servers.neat] to ~/.codex/config.toml and write')
  console.log('                   the graph-first block into ./AGENTS.md, merging into both')
  console.log('                   without touching your other servers or instructions')
  console.log('  --print-config   print the [mcp_servers.neat] TOML block to stdout')
  console.log('  --print-guide    print the AGENTS.md graph-first block to stdout')
  console.log('')
  console.log('Existing config is preserved and a re-run is a no-op. A malformed')
  console.log('config.toml is a clear error with no partial write.')
}

// Parse this command family's own argv and dispatch. Mirrors runHooksCommand /
// runConnectorCommand — a config command, not a locked query verb.
export async function runCodexCommand(args: string[]): Promise<number> {
  const opts: CodexOptions = { apply: false, printConfig: false, printGuide: false }
  for (const arg of args) {
    switch (arg) {
      case '--apply':
        opts.apply = true
        break
      case '--print-config':
        opts.printConfig = true
        break
      case '--print-guide':
        opts.printGuide = true
        break
      case '-h':
      case '--help':
        usage()
        return 0
      default:
        console.error(`neat codex: unknown flag "${arg}"`)
        usage()
        return 2
    }
  }
  try {
    const { exitCode } = await runCodex(opts)
    return exitCode
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
}
